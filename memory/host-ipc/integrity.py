"""Root authority provenance checks, before launching privileged JS modules."""
import os
import pathlib
import re
import stat
import subprocess

SHA = re.compile(r"^[0-9a-f]{40}$")
ENV = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent",
       "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
       "GIT_NO_REPLACE_OBJECTS": "1", "GIT_OPTIONAL_LOCKS": "0"}


def trusted_tree(root):
    """Refuse ANY mutable or unreviewed executable dependency, incl. symlinks."""
    try:
        parent = pathlib.Path(root)
        if not parent.is_absolute() or str(parent) != os.path.normpath(root):
            return False
        for node in [parent, *parent.parents]:
            st = node.lstat()
            if st.st_uid != 0 or not stat.S_ISDIR(st.st_mode) or st.st_mode & 0o022:
                return False
        scanned = 0
        for basedir, dirs, files in os.walk(root, topdown=True, followlinks=False):
            for name in (*dirs, *files):
                p = pathlib.Path(basedir) / name
                st = p.lstat()
                scanned += 1
                if scanned > 60000 or st.st_uid != 0 or st.st_mode & 0o022 or (
                    not stat.S_ISDIR(st.st_mode) and not stat.S_ISREG(st.st_mode)):
                    return False
        return scanned > 0
    except (OSError, TypeError, ValueError):
        return False


def reviewed_checkout(root, expected_sha, run=subprocess.run):
    if not isinstance(expected_sha, str) or not SHA.fullmatch(expected_sha) or not trusted_tree(root):
        return False
    try:
        # The full checkout including metadata and ignored files is root-only.
        # Untracked, staged, modified and ignored artifacts invalidate the build.
        args = [("/usr/bin/git", "rev-parse", "HEAD"),
                ("/usr/bin/git", "rev-parse", "--show-toplevel"),
                ("/usr/bin/git", "status", "--porcelain=v1", "--untracked-files=all"),
                ("/usr/bin/git", "ls-files", "--others", "--ignored", "--exclude-standard")]
        for index, argv in enumerate(args):
            result = run(list(argv), cwd=root, env=ENV,
                         capture_output=True, text=True, timeout=8)
            if result.returncode != 0:
                return False
            expected = (expected_sha, root, "", "")[index]
            if result.stdout.strip() != expected:
                return False
        return True
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return False


def trusted_release_file(root, file):
    return (isinstance(root, str) and isinstance(file, str) and
            file.startswith(root + "/") and
            os.path.normpath(file) == file and trusted_tree(root) and
            pathlib.Path(file).is_file())
