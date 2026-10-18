"""Verify only reviewed public files enter the wheel/sdist; never publish."""

from __future__ import annotations

import base64
import configparser
import csv
import hashlib
import io
import json
import sys
import tarfile
import tomllib
import zipfile
from email.parser import BytesParser
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
VERSION = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
STEM = f"agentdomain_autogen-{VERSION}"
FRAMEWORK_DEPENDENCIES = {
    "autogen-agentchat==0.7.5",
    "autogen-core==0.7.5",
    "autogen-ext[mcp]==0.7.5",
    "mcp==1.30.0",
    "pydantic==2.13.5",
}
PACKAGE_FILES = {
    "__init__.py",
    "__main__.py",
    "workbench.py",
    "cli.py",
    "assistant.py",
    "py.typed",
}
SOURCE_FILES = {
    ".gitignore",
    "pyproject.toml",
    "README.md",
    "LICENSE",
    "NOTICE",
    *("src/agentdomain_autogen/" + name for name in PACKAGE_FILES),
}


def metadata(raw: bytes) -> None:
    parsed = BytesParser().parsebytes(raw)
    assert parsed["Name"] == "agentdomain-autogen"
    assert parsed["Version"] == VERSION
    assert parsed["Requires-Python"] == ">=3.10"
    assert parsed["License-Expression"] == "Apache-2.0"
    assert set(parsed.get_all("License-File")) == {"LICENSE", "NOTICE"}
    assert set(parsed.get_all("Requires-Dist")) == FRAMEWORK_DEPENDENCIES


def verify(directory: Path) -> dict:
    dependency_file = (
        ROOT.parent / "mcp-server/examples/autogen/framework-requirements.txt"
    )
    requirements = {
        line.strip()
        for line in dependency_file.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    assert requirements == FRAMEWORK_DEPENDENCIES, (
        "CI dependency drift/self-install cycle"
    )
    wheel = directory / (STEM + "-py3-none-any.whl")
    sdist = directory / (STEM + ".tar.gz")
    info = STEM + ".dist-info/"
    with zipfile.ZipFile(wheel) as archive:
        expected = {"agentdomain_autogen/" + name for name in PACKAGE_FILES} | {
            info + name
            for name in (
                "METADATA",
                "WHEEL",
                "RECORD",
                "entry_points.txt",
                "licenses/LICENSE",
                "licenses/NOTICE",
            )
        }
        assert set(archive.namelist()) == expected, archive.namelist()
        assert len(archive.namelist()) == len(expected), "Duplicate wheel member"
        metadata(archive.read(info + "METADATA"))
        assert b"Tag: py3-none-any" in archive.read(info + "WHEEL")
        for name in PACKAGE_FILES:
            assert (
                archive.read("agentdomain_autogen/" + name)
                == (ROOT / "src/agentdomain_autogen" / name).read_bytes()
            ), name
        entries = configparser.ConfigParser()
        entries.read_string(archive.read(info + "entry_points.txt").decode())
        assert dict(entries["console_scripts"]) == {
            "agentdomain-autogen": "agentdomain_autogen.cli:main",
            "agentdomain-autogen-assistant": "agentdomain_autogen.assistant:main",
        }
        records = list(csv.reader(io.StringIO(archive.read(info + "RECORD").decode())))
        assert {row[0] for row in records} == expected
        for name, digest, size in records:
            if name == info + "RECORD":
                assert not digest and not size
                continue
            content = archive.read(name)
            encoded = (
                base64.urlsafe_b64encode(hashlib.sha256(content).digest())
                .rstrip(b"=")
                .decode()
            )
            assert digest == "sha256=" + encoded and int(size) == len(content), name
    with tarfile.open(sdist, "r:gz") as archive:
        members = archive.getmembers()
        assert all(member.isfile() or member.isdir() for member in members)
        files = {}
        for member in members:
            path = PurePosixPath(member.name)
            assert path.parts[0] == STEM and ".." not in path.parts
            if member.isfile():
                relative = "/".join(path.parts[1:])
                assert relative not in files
                files[relative] = archive.extractfile(member).read()
        assert set(files) == SOURCE_FILES | {"PKG-INFO"}, sorted(files)
        metadata(files["PKG-INFO"])
        for name in SOURCE_FILES:
            assert files[name] == (ROOT / name).read_bytes(), name
    return {
        "version": VERSION,
        "wheelFiles": len(expected),
        "sdistFiles": len(files),
        "allowlist": "passed",
        "metadata": "passed",
        "recordHashes": "passed",
        "frameworkOnlyDependencies": "passed",
        "wheelSha256": hashlib.sha256(wheel.read_bytes()).hexdigest(),
        "sdistSha256": hashlib.sha256(sdist.read_bytes()).hexdigest(),
    }


if __name__ == "__main__":
    print(json.dumps(verify(Path(sys.argv[1]).resolve(strict=True)), indent=2))
