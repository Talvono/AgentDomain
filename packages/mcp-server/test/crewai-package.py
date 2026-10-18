"""Verify built artifacts and the actual non-editable installed Python wheel."""

import argparse
import base64
import csv
from email.parser import BytesParser
import hashlib
import importlib.metadata
import io
import json
from pathlib import Path
import stat
import subprocess
import sys
import sysconfig
import tomllib
import tarfile
import tempfile
import unittest
import zipfile

import agentdomain_crewai
from agentdomain_crewai import child_environment


VERSION = tomllib.loads((Path(__file__).resolve().parents[2] / "crewai-plugin/pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
DIST_INFO = f"agentdomain_crewai-{VERSION}.dist-info"
MODULE_FILES = {
    "agentdomain_crewai/__init__.py",
    "agentdomain_crewai/__main__.py",
    "agentdomain_crewai/connector.py",
    "agentdomain_crewai/py.typed",
}
WHEEL_FILES = MODULE_FILES | {
    f"{DIST_INFO}/METADATA",
    f"{DIST_INFO}/WHEEL",
    f"{DIST_INFO}/RECORD",
    f"{DIST_INFO}/entry_points.txt",
    f"{DIST_INFO}/licenses/LICENSE",
    f"{DIST_INFO}/licenses/NOTICE",
}
SDIST_FILES = {f"src/{name}" for name in MODULE_FILES} | {
    ".gitignore",
    "pyproject.toml",
    "README.md",
    "LICENSE",
    "NOTICE",
    "PKG-INFO",
}
DEFAULT_DIST = Path(__file__).resolve().parents[2] / "crewai-plugin" / "dist"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--dist", type=Path, default=DEFAULT_DIST)
arguments, test_arguments = parser.parse_known_args()
DIST = arguments.dist.resolve(strict=True)


class PackageTests(unittest.TestCase):
    def test_wheel_has_exact_allowlist_and_valid_record_hashes(self):
        with zipfile.ZipFile(
            DIST / f"agentdomain_crewai-{VERSION}-py3-none-any.whl"
        ) as wheel:
            self.assertEqual(len(wheel.namelist()), len(WHEEL_FILES))
            self.assertEqual(set(wheel.namelist()), WHEEL_FILES)
            for item in wheel.infolist():
                self.assertFalse(stat.S_ISLNK(item.external_attr >> 16))
            rows = list(
                csv.reader(io.StringIO(wheel.read(f"{DIST_INFO}/RECORD").decode()))
            )
            self.assertEqual(len(rows), len(WHEEL_FILES))
            self.assertEqual({row[0] for row in rows}, WHEEL_FILES)
            for name, digest, size in rows:
                if name.endswith("/RECORD"):
                    self.assertEqual((digest, size), ("", ""))
                    continue
                data = wheel.read(name)
                self.assertEqual(int(size), len(data))
                expected = base64.urlsafe_b64encode(hashlib.sha256(data).digest())
                self.assertEqual(digest, "sha256=" + expected.decode().rstrip("="))
            self.assert_metadata(wheel.read(f"{DIST_INFO}/METADATA"))
            self.assertIn(
                b"Apache License", wheel.read(f"{DIST_INFO}/licenses/LICENSE")
            )
            self.assertIn(
                b"agentdomain-crewai = agentdomain_crewai.connector:main",
                wheel.read(f"{DIST_INFO}/entry_points.txt"),
            )

    def assert_metadata(self, raw):
        metadata = BytesParser().parsebytes(raw)
        self.assertEqual(metadata["Name"], "agentdomain-crewai")
        self.assertEqual(metadata["Version"], VERSION)
        self.assertEqual(metadata["License-Expression"], "Apache-2.0")
        self.assertEqual(
            set(metadata.get_all("License-File", [])), {"LICENSE", "NOTICE"}
        )
        self.assertEqual(
            set(metadata.get_all("Requires-Dist", [])),
            {"crewai==1.15.21", "mcp==1.28.1"},
        )
        self.assertEqual(
            set(metadata["Requires-Python"].split(",")), {">=3.12", "<3.13"}
        )

    def test_sdist_contains_only_rebuildable_source_and_matching_metadata(self):
        prefix = f"agentdomain_crewai-{VERSION}/"
        with (
            tarfile.open(DIST / f"agentdomain_crewai-{VERSION}.tar.gz") as sdist,
            zipfile.ZipFile(
                DIST / f"agentdomain_crewai-{VERSION}-py3-none-any.whl"
            ) as wheel,
        ):
            members = sdist.getmembers()
            self.assertEqual(len(members), len(SDIST_FILES))
            self.assertEqual(
                {m.name for m in members}, {prefix + n for n in SDIST_FILES}
            )
            for member in members:
                self.assertTrue(member.isfile(), member.name)
            for name in MODULE_FILES:
                stream = sdist.extractfile(prefix + "src/" + name)
                self.assertIsNotNone(stream)
                assert stream is not None
                self.assertEqual(stream.read(), wheel.read(name))
            info = sdist.extractfile(prefix + "PKG-INFO")
            assert info is not None
            self.assert_metadata(info.read())

    def test_installed_noneditable_package_matches_actual_wheel_bytes(self):
        distribution = importlib.metadata.distribution("agentdomain-crewai")
        self.assertEqual(distribution.version, VERSION)
        self.assertEqual(agentdomain_crewai.__version__, VERSION)
        root = Path(sysconfig.get_path("purelib")).resolve(strict=True)
        assert agentdomain_crewai.__file__ is not None
        self.assertTrue(
            Path(agentdomain_crewai.__file__).resolve().is_relative_to(root)
        )
        direct_url = distribution.read_text("direct_url.json")
        self.assertIsNotNone(
            direct_url, "Install the reviewed local wheel for qualification"
        )
        assert direct_url is not None
        origin = json.loads(direct_url)
        self.assertFalse(origin.get("dir_info", {}).get("editable", False))
        self.assertIn("archive_info", origin)
        wheel_path = DIST / f"agentdomain_crewai-{VERSION}-py3-none-any.whl"
        self.assertEqual(origin["url"], wheel_path.as_uri())
        recorded_hash = origin["archive_info"].get("hashes", {}).get("sha256")
        if recorded_hash is not None:
            self.assertEqual(
                recorded_hash, hashlib.sha256(wheel_path.read_bytes()).hexdigest()
            )
        with zipfile.ZipFile(wheel_path) as wheel:
            for name in WHEEL_FILES - {f"{DIST_INFO}/RECORD"}:
                self.assertEqual((root / name).read_bytes(), wheel.read(name))
        entries = [
            e for e in distribution.entry_points if e.name == "agentdomain-crewai"
        ]
        self.assertEqual(len(entries), 1)
        self.assertIs(entries[0].load(), agentdomain_crewai.main)

    def test_installed_console_and_module_work_outside_source_checkout(self):
        script = Path(sysconfig.get_path("scripts")) / (
            "agentdomain-crewai.exe"
            if sys.platform == "win32"
            else "agentdomain-crewai"
        )
        self.assertTrue(script.is_file())
        with tempfile.TemporaryDirectory(prefix="agentdomain-crewai-consumer-") as cwd:
            for command in (
                [str(script), "--help"],
                [sys.executable, "-I", "-B", "-m", "agentdomain_crewai", "--help"],
            ):
                result = subprocess.run(
                    command,
                    cwd=cwd,
                    env=child_environment(),
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("--expected-owner", result.stdout)
                self.assertIn("--setting", result.stdout)
                self.assertNotIn("--private-key", result.stdout)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *test_arguments])
