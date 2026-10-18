"""Bounded, non-extracting release archive checks and Python artifact builder."""

import argparse
import email.parser
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tomllib
import urllib.error
import urllib.request
import zipfile

PYTHON_PACKAGES = {"agentdomain-crewai": "crewai-plugin", "agentdomain-autogen": "autogen-plugin"}
NPM_PACKAGES = ["shared", "sdk", "mcp-server", "agentkit-plugin", "eliza-plugin", "langchain-plugin"]
MAX_ARCHIVE = 64 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
MAX_REGISTRY = 4 * 1024 * 1024
REGISTRY_TIMEOUT = 10
POLICY = json.loads(Path(__file__).with_name("public-release-policy.json").read_bytes())


def require(condition, code="INVALID_RELEASE_ARTIFACT"):
    if not condition:
        raise ValueError(code)


def stable_version(value):
    require(isinstance(value, str) and re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", value))
    return value


def source_version(repo=None):
    repo = Path(repo) if repo is not None else Path(__file__).resolve().parent.parent
    versions = []
    for slug in NPM_PACKAGES:
        manifest = json.loads((repo / "packages" / slug / "package.json").read_bytes())
        require(manifest.get("name") == f"@agentdomain/{slug}" and not manifest.get("private"))
        versions.append(stable_version(manifest.get("version")))
    for name, folder in PYTHON_PACKAGES.items():
        project = tomllib.loads((repo / "packages" / folder / "pyproject.toml").read_text(encoding="utf-8"))["project"]
        require(project.get("name") == name)
        versions.append(stable_version(project.get("version")))
    require(len(set(versions)) == 1, "RELEASE_VERSION_MISMATCH")
    return versions[0]


def source_repository(environment):
    owner = environment.get("GITHUB_REPOSITORY_OWNER")
    require(owner in POLICY["owners"])
    repository = f"{owner}/{POLICY['repository']}"
    require(environment.get("GITHUB_REPOSITORY") == repository)
    require(environment.get("GITHUB_REPOSITORY_ID") == POLICY["repositoryId"])
    require(environment.get("GITHUB_REPOSITORY_OWNER_ID") == POLICY["owners"][owner])
    return repository


def publication_repository(environment):
    repository = source_repository(environment)
    require(environment.get("GITHUB_REPOSITORY_OWNER") == POLICY["activeOwner"])
    require(environment.get("GITHUB_REF") == "refs/heads/main")
    require(re.fullmatch(r"[0-9a-f]{40}", environment.get("GITHUB_SHA", "")))
    require(environment.get("GITHUB_ACTOR") == POLICY["operator"]["login"])
    require(environment.get("GITHUB_ACTOR_ID") == POLICY["operator"]["id"])
    require(environment.get("GITHUB_TRIGGERING_ACTOR") == POLICY["operator"]["login"])
    require(environment.get("GITHUB_WORKFLOW_REF") == f"{repository}/.github/workflows/publish-python.yml@refs/heads/main")
    return repository


def digest(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= MAX_ARCHIVE)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def safe_name(name, tooling=False):
    require(isinstance(name, str) and bool(name) and "\\" not in name and ":" not in name)
    parts = name.rstrip("/").split("/")
    require(all(p not in ("", ".", "..") for p in parts))
    require(not PurePosixPath(name).is_absolute())
    require(not any(p.lower() in (".git", ".env", ".qa", ".codex", "secrets.json", "operations.env", "backend.env", "frontend.env") or p.lower().startswith(".venv") for p in parts))
    require(not name.endswith((".pfx", ".key")))
    # npm's immutable upstream CLI includes node-gyp Python bytecode; our
    # product distributions must never ship locally generated caches.
    require(tooling or ("__pycache__" not in parts and not name.endswith(".pyc")))


def contents(path, tooling=False):
    digest(path)
    result = {}
    expanded = 0
    if path.name.endswith(".whl"):
        with zipfile.ZipFile(path) as archive:
            require(len(archive.infolist()) <= 20000)
            for item in archive.infolist():
                safe_name(item.filename, tooling)
                require(not stat.S_ISLNK(item.external_attr >> 16))
                require(item.filename not in result)
                expanded += item.file_size
                require(expanded <= MAX_EXPANDED)
                result[item.filename] = b"" if item.is_dir() else archive.read(item)
    else:
        with tarfile.open(path, "r:gz") as archive:
            for index, item in enumerate(archive):
                require(index < 20000 and (item.isfile() or item.isdir()))
                safe_name(item.name, tooling)
                require(item.name not in result)
                expanded += item.size
                require(expanded <= MAX_EXPANDED)
                result[item.name] = archive.extractfile(item).read() if item.isfile() else b""
    require(result)
    return result


def apache_license(files, prefix):
    license_text = files.get(prefix + "LICENSE", b"")
    require(b"Apache License" in license_text and b"Version 2.0, January 2004" in license_text)
    require(bool(files.get(prefix + "NOTICE", b"").strip()))


def inspect_npm_package(path, name, version):
    stable_version(version)
    require(name in [f"@agentdomain/{slug}" for slug in NPM_PACKAGES])
    files = contents(path)
    require(all(member.startswith("package/") or member == "package" for member in files))
    manifest = json.loads(files["package/package.json"])
    require(manifest["name"] == name and manifest["version"] == version and not manifest.get("private"))
    require(manifest.get("license") == "Apache-2.0")
    apache_license(files, "package/")


def inspect_python(path, project, version):
    stable_version(version)
    require(project in PYTHON_PACKAGES)
    normalized = project.replace("-", "_")
    expected = {f"{normalized}-{version}-py3-none-any.whl", f"{normalized}-{version}.tar.gz"}
    require(path.name in expected)
    files = contents(path)
    metadata = f"{normalized}-{version}.dist-info/METADATA" if path.name.endswith(".whl") else f"{normalized}-{version}/PKG-INFO"
    require(metadata in files)
    parsed = email.parser.BytesParser().parsebytes(files[metadata])
    require(parsed.get_all("Name") == [project] and parsed.get_all("Version") == [version])
    require(parsed.get_all("License-Expression") == ["Apache-2.0"])
    require(sorted(parsed.get_all("License-File") or []) == ["LICENSE", "NOTICE"])
    license_prefix = f"{normalized}-{version}.dist-info/licenses/" if path.name.endswith(".whl") else f"{normalized}-{version}/"
    apache_license(files, license_prefix)
    require(any(name.endswith("/__init__.py") and f"{normalized}/" in name for name in files))
    if path.name.endswith(".whl"):
        require(all(name.startswith((f"{normalized}/", f"{normalized}-{version}.dist-info/")) for name in files))
    else:
        require(all(name.startswith(f"{normalized}-{version}/") for name in files))
    return {"filename": path.name, "sha256": digest(path), "bytes": path.stat().st_size, "project": project}


def inspect_npm(root):
    rows = (root / "publish-order.tsv").read_text().splitlines()
    require(len(rows) == len(NPM_PACKAGES))
    first = rows[0].split("\t")
    require(len(first) == 3)
    version = stable_version(first[1])
    for row, slug in zip(rows, NPM_PACKAGES):
        expected = [f"@agentdomain/{slug}", version, f"packages/agentdomain-{slug}-{version}.tgz"]
        require(row.split("\t") == expected)
        inspect_npm_package(root / expected[2], expected[0], version)
    tooling = contents(root / "tooling/npm-11.5.1.tgz", tooling=True)
    require(all(name.startswith("package/") or name == "package" for name in tooling))
    manifest = json.loads(tooling["package/package.json"])
    require(manifest["name"] == "npm" and manifest["version"] == "11.5.1")


def python_inventory(root, version):
    stable_version(version)
    expected = {f"{name.replace('-', '_')}-{version}{suffix}": name for name in PYTHON_PACKAGES for suffix in ("-py3-none-any.whl", ".tar.gz")}
    directory = root / "dist"
    require(directory.is_dir() and not directory.is_symlink())
    require({p.name for p in directory.iterdir()} == set(expected))
    return [inspect_python(directory / name, project, version) for name, project in sorted(expected.items())]


def build_python(root):
    repo = Path(__file__).resolve().parent.parent
    version = source_version(repo)
    repository = source_repository(os.environ) if os.environ.get("GITHUB_REPOSITORY") else f"{POLICY['activeOwner']}/{POLICY['repository']}"
    root.mkdir(parents=True, exist_ok=False)
    (root / "dist").mkdir()
    for folder in PYTHON_PACKAGES.values():
        subprocess.run([sys.executable, "-m", "build", "--no-isolation", "--outdir", str(root / "dist"), str(repo / "packages" / folder)], check=True, timeout=180)
    sha = os.environ.get("GITHUB_SHA") or subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    require(re.fullmatch(r"[0-9a-f]{40}", sha))
    manifest = {"schema": 1, "repository": repository, "sha": sha, "version": version, "files": python_inventory(root, version)}
    (root / "release.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    seal = digest(root / "release.json")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write(f"release-manifest-sha256={seal}\n")
    print(f"Validated four Python artifacts; manifest SHA256 {seal}")


def verify_python(root):
    repository = publication_repository(os.environ)
    expected = os.environ.get("EXPECTED_RELEASE_MANIFEST_SHA256", "")
    require(re.fullmatch(r"[0-9a-f]{64}", expected))
    require(digest(root / "release.json") == expected)
    manifest = json.loads((root / "release.json").read_bytes())
    version = stable_version(manifest.get("version"))
    require(manifest == {"schema": 1, "repository": repository, "sha": os.environ.get("GITHUB_SHA"), "version": version, "files": python_inventory(root, version)})
    return manifest


class NoRegistryRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def python_registry(project, version):
    require(project in PYTHON_PACKAGES)
    stable_version(version)
    request = urllib.request.Request(f"https://pypi.org/pypi/{project}/{version}/json", headers={"Accept": "application/json"})
    try:
        with urllib.request.build_opener(NoRegistryRedirect).open(request, timeout=REGISTRY_TIMEOUT) as response:
            require(response.status == 200)
            payload = response.read(MAX_REGISTRY + 1)
            require(len(payload) <= MAX_REGISTRY)
            return {"status": 200, "body": json.loads(payload)}
    except urllib.error.HTTPError as error:
        error.close()
        require(error.code == 404, "PYPI_LOOKUP_FAILED")
        return {"status": 404}


def missing_python(manifest, lookup):
    missing = []
    existing_unqualified = False
    for project in PYTHON_PACKAGES:
        rows = [row for row in manifest["files"] if row["project"] == project]
        response = lookup(project, manifest["version"])
        if response["status"] == 404:
            missing.extend(rows)
            continue
        require(response["status"] == 200, "PYPI_LOOKUP_FAILED")
        body = response["body"]
        require(body.get("info", {}).get("name") == project and body["info"].get("version") == manifest["version"])
        files = body.get("urls")
        require(isinstance(files, list))
        expected = {row["filename"]: row for row in rows}
        seen = set()
        for file in files:
            name = file.get("filename")
            require(name in expected and name not in seen)
            seen.add(name)
            row = expected[name]
            require(file.get("digests", {}).get("sha256") == row["sha256"] and file.get("size") == row["bytes"] and not file.get("yanked"))
            existing_unqualified = True
        require(seen, "PYPI_LOOKUP_FAILED")
        missing.extend(row for row in rows if row["filename"] not in seen)
    # Hashes and unsigned registry metadata cannot establish signed source/workflow provenance.
    require(not existing_unqualified, "EXISTING_PYPI_PROVENANCE_UNQUALIFIED")
    return missing


def stage_python(root, project, lookup=None):
    require(project in ("all", *PYTHON_PACKAGES))
    require(root.is_dir() and not root.is_symlink())
    # Selection never narrows the sealed input inventory or its validation.
    manifest = verify_python(root)
    missing = missing_python(manifest, python_registry if lookup is None else lookup)
    selected = [row for row in missing if project == "all" or row["project"] == project]
    directory = root / "publish-dist"
    directory.mkdir(exist_ok=False)
    for row in selected:
        require(directory.is_dir() and not directory.is_symlink())
        source = root / "dist" / row["filename"]
        require(source.is_file() and not source.is_symlink() and source.stat().st_size == row["bytes"])
        with source.open("rb") as original, (directory / row["filename"]).open("xb") as staged:
            shutil.copyfileobj(original, staged)
    require(directory.is_dir() and not directory.is_symlink())
    require({path.name for path in directory.iterdir()} == {row["filename"] for row in selected})
    require([inspect_python(directory / row["filename"], row["project"], manifest["version"]) for row in selected] == selected)
    require(verify_python(root) == manifest)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write(f"publish-needed={'true' if selected else 'false'}\n")
    return selected


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("command", choices=("source-version", "build-python", "verify-python", "stage-python", "verify-npm"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--project", choices=("all", *PYTHON_PACKAGES))
    args = parser.parse_args()
    if args.command == "source-version":
        if args.output is not None or args.project is not None:
            parser.error("source-version accepts no output or project")
        print(source_version())
        return
    if args.output is None:
        parser.error(f"{args.command} requires --output")
    if args.command == "stage-python":
        if args.project is None:
            parser.error("stage-python requires --project")
        selected = stage_python(args.output.absolute(), args.project)
        print(f"Staged {len(selected)} verified Python artifacts for {args.project}.")
        return
    if args.project is not None:
        parser.error("--project is only valid with stage-python")
    root = args.output.resolve()
    {"build-python": build_python, "verify-python": verify_python, "verify-npm": inspect_npm}[args.command](root)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Existing PyPI artifacts require qualified signed provenance; nothing was staged." if str(error) == "EXISTING_PYPI_PROVENANCE_UNQUALIFIED" else "Release artifact validation failed; nothing was published.", file=sys.stderr)
        sys.exit(1)
