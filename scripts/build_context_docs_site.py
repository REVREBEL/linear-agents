#!/usr/bin/env python3
"""ABR-89 E5: generate a static, source-pinned documentation site from Git READMEs.

Reads immutable Git objects only. Never reads live /opt roots, executes project
code, publishes to a web host, or modifies checked-out source documentation.
"""
import argparse
import hashlib
import html
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import quote, unquote, urlsplit, urlunsplit

from markdown_it import MarkdownIt
import yaml

VERSION = 1
MAX_README_BYTES = 1024 * 1024
REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
HEX = re.compile(r"[0-9a-f]{40,64}\Z")
STYLE = """:root{color-scheme:light;--ink:#1f2937;--navy:#163666;--mint:#71c9c5;--line:#d8e2e9}
*{box-sizing:border-box}body{margin:0;background:#f7fafc;color:var(--ink);font:16px/1.65 system-ui,-apple-system,Segoe UI,sans-serif}
header{background:var(--navy);color:white;padding:1.3rem max(1.2rem,calc((100vw - 1050px)/2))}
header a{color:white}header p{margin:.3rem 0 0;color:#d7e9f5}
main{max-width:1050px;padding:2rem 1.2rem 4rem;margin:auto}
h1,h2,h3{line-height:1.25}h1{font-size:2rem}h2{margin-top:1.9rem}
a{color:#16568a;text-underline-offset:3px}a:hover{text-decoration-thickness:2px}
.document{background:white;border:1px solid var(--line);border-radius:9px;padding:1.5rem 2rem}
.metadata{font-size:.89rem;color:#596977;overflow-wrap:anywhere}
code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
code{background:#eef3f7;padding:.08rem .25rem;border-radius:3px}
pre{background:#f0f4f7;max-width:100%;overflow:auto;padding:1rem;border-radius:6px}
pre code{padding:0;background:none}table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}
td,th{padding:.4rem .7rem;border:1px solid var(--line);text-align:left}
blockquote{margin-left:0;border-left:4px solid var(--mint);padding-left:1rem}
img{max-width:100%}hr{border:0;border-top:1px solid var(--line)}
.groups{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}
.group{background:white;border:1px solid var(--line);border-radius:8px;padding:1rem}
.group h2{margin:.2rem 0 .6rem;font-size:1.2rem}.group ul{padding-left:1.3rem}
.group li{margin:.35rem 0}.source-path{display:block;color:#64748b;font-size:.78rem;overflow-wrap:anywhere}
.bottom-nav{display:flex;justify-content:space-between;gap:1rem;margin-top:1.5rem}
footer{max-width:1050px;padding:1rem 1.2rem 3rem;margin:auto;color:#556779}
"""


def git(repo, *args):
    proc = subprocess.run(
        ["git", "-C", str(repo), *args], stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=False,
    )
    if proc.returncode:
        raise ValueError("Git source inspection failed: " +
                         proc.stderr.decode("utf-8", "replace").strip()[:900])
    return proc.stdout


def clean_path(path):
    if not path or "\\" in path or "\x00" in path or any(
        ord(c) < 32 for c in path
    ):
        raise ValueError("Unsafe Git documentation path")
    pure = PurePosixPath(path)
    if pure.is_absolute() or any(p in (".", "..", "") for p in path.split("/")):
        raise ValueError("Unsafe Git documentation path")
    return path


def documents_in_commit(repo):
    top = Path(git(repo, "rev-parse", "--show-toplevel").decode().strip()).resolve()
    if top != repo.resolve():
        raise ValueError("Explicit repo-root must be the Git checkout root")
    head = git(repo, "rev-parse", "HEAD").decode().strip()
    tree = git(repo, "rev-parse", "HEAD^{tree}").decode().strip()
    if not HEX.fullmatch(head) or not HEX.fullmatch(tree):
        raise ValueError("Invalid pinned Git revision")
    raw = git(repo, "ls-tree", "-r", "-z", "HEAD")
    entries = []
    for item in raw.split(b"\x00"):
        if not item:
            continue
        meta, raw_path = item.split(b"\t", 1)
        mode, object_type, oid = meta.decode("ascii").split(" ")
        path = clean_path(raw_path.decode("utf-8"))
        if PurePosixPath(path).name != "README.md":
            continue
        if object_type != "blob" or mode not in ("100644", "100755"):
            raise ValueError("README must be a regular Git file: " + path)
        content = git(repo, "cat-file", "blob", oid)
        if len(content) > MAX_README_BYTES:
            raise ValueError("README exceeds safe full-content limit: " + path)
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("README must be UTF-8: " + path) from exc
        modified = git(repo, "log", "-1", "--format=%H", "HEAD", "--",
                       path).decode().strip()
        if not HEX.fullmatch(modified):
            raise ValueError("Missing README source revision: " + path)
        entries.append({
            "path": path, "text": text, "blobSha": oid,
            "lastCommit": modified, "sha256": hashlib.sha256(content).hexdigest(),
            "raw": content,
        })
    if not entries:
        raise ValueError("No tracked README.md sources in Git commit")
    entries.sort(key=lambda item: item["path"])
    return head, tree, entries


def title_and_body(text, path):
    context_id = None
    body = text
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1 and end < 8192:
            try:
                metadata = yaml.safe_load(text[4:end])
            except yaml.YAMLError:
                metadata = None
            if isinstance(metadata, dict):
                context = metadata.get("context")
                if isinstance(context, dict):
                    if isinstance(context.get("id"), str):
                        context_id = context["id"]
                    if isinstance(context.get("title"), str):
                        title = context["title"].strip()
                    else:
                        title = None
                    body = text[end + 5:]
                    if title:
                        return title[:180], body, context_id
    match = re.search(r"(?m)^#{1,2}\s+(.+?)\s*#*\s*$", body)
    return ((match.group(1).strip() if match else
             ("Project overview" if path == "README.md" else
              posixpath.dirname(path) or "Documentation"))[:180],
            body, context_id)


def page_path(source):
    directory = posixpath.dirname(source)
    return "pages/" + (directory + "/" if directory else "") + "index.html"


def raw_path(source):
    return "sources/" + source


def source_permalink(repository, head, path, *, raw=False):
    prefix = "https://raw.githubusercontent.com/" if raw else "https://github.com/"
    tail = (repository + "/" + head + "/" if raw else
            repository + "/blob/" + head + "/")
    return prefix + tail + quote(path, safe="/")


def local_href(value, source, html_path, page_by_source, repository, head, *, image=False):
    if not value:
        return value
    parts = urlsplit(value)
    if parts.scheme:
        return value if parts.scheme.lower() in ("http", "https", "mailto") else "#"
    if parts.netloc:
        return "#"  # Do not turn protocol-relative input into an unpinned source.
    if not parts.path:
        return value if parts.fragment else "#"
    decoded = unquote(parts.path)
    if decoded.startswith("/") or "\\" in decoded or "\x00" in decoded:
        return "#"
    dest = posixpath.normpath(posixpath.join(posixpath.dirname(source), decoded))
    if dest == ".." or dest.startswith("../"):
        return "#"
    if dest == ".":
        if not image and "README.md" in page_by_source:
            dest = "README.md"
        else:
            return f"https://github.com/{repository}/tree/{head}"
    dest = clean_path(dest)
    if dest not in page_by_source and dest + "/README.md" in page_by_source:
        dest += "/README.md"
    if not image and dest in page_by_source:
        link = posixpath.relpath(page_by_source[dest],
                                posixpath.dirname(html_path))
        return urlunsplit(("", "", quote(link, safe="/."), parts.query, parts.fragment))
    link = source_permalink(repository, head, dest, raw=image)
    return urlunsplit((urlsplit(link).scheme, urlsplit(link).netloc,
                       urlsplit(link).path, parts.query, parts.fragment))


def attach_heading_ids(tokens):
    """Use familiar GitHub-style, deterministic fragment targets for headings."""
    seen = {}
    for index, token in enumerate(tokens[:-1]):
        if token.type != "heading_open":
            continue
        inline = tokens[index + 1]
        if inline.type != "inline":
            continue
        visible = "".join(
            part.content if part.type in ("text", "code_inline", "image") else
            " " if part.type in ("softbreak", "hardbreak") else ""
            for part in inline.children or []
        )
        stem = re.sub(r"[^\w\-\s]", "", visible.casefold().strip())
        stem = re.sub(r"\s", "-", stem) or "section"
        count = seen.get(stem, 0)
        seen[stem] = count + 1
        token.attrSet("id", stem if count == 0 else f"{stem}-{count}")


def markdown_html(body, source, html_path, page_by_source, repository, head):
    renderer = MarkdownIt("commonmark", {"html": False, "linkify": False})
    renderer.enable("table")
    tokens = renderer.parse(body)
    attach_heading_ids(tokens)
    for token in tokens:
        for child in token.children or []:
            if child.type not in ("link_open", "image"):
                continue
            key = "href" if child.type == "link_open" else "src"
            url = child.attrGet(key)
            if url:
                child.attrSet(key, local_href(
                    url, source, html_path, page_by_source, repository, head,
                    image=child.type == "image",
                ))
    return renderer.renderer.render(tokens, renderer.options, {})


def document_page(item, position, items, page_by_source, repository, head, build_id):
    title = html.escape(item["title"])
    page = item["htmlPath"]
    prefix = lambda dest: html.escape(
        posixpath.relpath(dest, posixpath.dirname(page)), quote=True,
    )
    body = markdown_html(item["body"], item["path"], page, page_by_source,
                         repository, head)
    before = items[position - 1] if position else None
    after = items[position + 1] if position + 1 < len(items) else None
    previous = (f'<a href="{prefix(before["htmlPath"])}">Previous: '
                f'{html.escape(before["title"])}</a>') if before else "<span></span>"
    following = (f'<a href="{prefix(after["htmlPath"])}">Next: '
                 f'{html.escape(after["title"])}</a>') if after else "<span></span>"
    ref = source_permalink(repository, head, item["path"])
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<meta name="referrer" content="no-referrer">'
            f'<title>{title} — Source-linked documentation</title>'
            f'<link rel="stylesheet" href="{prefix("assets/style.css")}"></head>'
            f'<body><header><a href="{prefix("index.html")}">All documentation</a>'
            f'<p>Build {build_id} · Git {head[:12]}</p></header>'
            f'<main><article class="document"><h1>{title}</h1>'
            f'<p class="metadata">Source: <code>{html.escape(item["path"])}</code><br>'
            f'Source revision: <code>{item["lastCommit"]}</code><br>'
            f'SHA-256: <code>{item["sha256"]}</code><br>'
            f'<a href="{html.escape(ref, quote=True)}">Pinned Git source</a> · '
            f'<a href="{prefix(item["rawPath"])}">Original Markdown</a></p>'
            f'<hr>{body}</article><nav class="bottom-nav" aria-label="Documents">'
            f'{previous}{following}</nav></main>'
            f'<footer>Generated from Git-tracked README files. Read-only documentation; '
            f'not runtime configuration or agent authority.</footer></body></html>\n').encode("utf-8")


def index_page(items, repository, head, build_id):
    groups = {}
    for item in items:
        group = item["path"].split("/", 1)[0] if "/" in item["path"] else "Project root"
        groups.setdefault(group, []).append(item)
    sections = []
    for group, group_items in sorted(groups.items(), key=lambda x: x[0].casefold()):
        links = "".join(
            f'<li><a href="{html.escape(quote(item["htmlPath"], safe="/."), quote=True)}">'
            f'{html.escape(item["title"])}</a>'
            f'<span class="source-path">{html.escape(item["path"])}</span></li>'
            for item in group_items
        )
        sections.append(f'<section class="group"><h2>{html.escape(group)} '
                        f'({len(group_items)})</h2><ul>{links}</ul></section>')
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<meta name="referrer" content="no-referrer">'
            f'<title>Source-linked README documentation</title>'
            f'<link rel="stylesheet" href="assets/style.css"></head>'
            f'<body><header><strong>Source-linked documentation</strong>'
            f'<p>{html.escape(repository)} · Git {head[:12]} · '
            f'Build {build_id}</p></header><main>'
            f'<h1>Repository documentation</h1>'
            f'<p>{len(items)} complete Git-tracked README files, indexed without '
            f'rewriting their original sources. Every page links to its pinned '
            f'Git source and unmodified Markdown.</p>'
            f'<p><a href="provenance.json">Full provenance manifest (JSON)</a></p>'
            f'<div class="groups">{"".join(sections)}</div></main>'
            f'<footer>Versioned static artifact. No remote content or agent '
            f'execution is used to build this site.</footer></body></html>\n').encode("utf-8")


def build_files(repo, repository):
    if not REPOSITORY.fullmatch(repository) or ".." in repository.split("/"):
        raise ValueError("Repository must be an owner/name identifier")
    head, tree, sources = documents_in_commit(repo)
    documents, files = [], {}
    for source in sources:
        path = source["path"]
        title, body, context_id = title_and_body(source["text"], path)
        documents.append({
            "path": path, "title": title, "contextId": context_id,
            "blobSha": source["blobSha"], "lastCommit": source["lastCommit"],
            "sha256": source["sha256"], "htmlPath": page_path(path),
            "rawPath": raw_path(path),
            "gitUrl": source_permalink(repository, head, path),
            "body": body, "raw": source["raw"],
        })
    stable = [{k: v for k, v in doc.items() if k not in ("body", "raw")}
              for doc in documents]
    descriptor = json.dumps(
        {"schemaVersion": VERSION, "sourceCommit": head,
         "repository": repository, "documents": stable},
        sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode("utf-8")
    build_id = hashlib.sha256(descriptor).hexdigest()[:16]
    provenance = {
        "schemaVersion": VERSION, "repository": repository,
        "sourceCommit": head, "sourceTree": tree,
        "buildId": build_id, "documentCount": len(documents),
        "documents": stable,
    }
    files["provenance.json"] = (
        json.dumps(provenance, sort_keys=True, indent=2, ensure_ascii=False)
        + "\n").encode("utf-8")
    files["assets/style.css"] = STYLE.encode("utf-8")
    files["index.html"] = index_page(documents, repository, head, build_id)
    page_by_source = {doc["path"]: doc["htmlPath"] for doc in documents}
    for i, doc in enumerate(documents):
        for key, contents in (
            (doc["htmlPath"], document_page(
                doc, i, documents, page_by_source, repository, head, build_id)),
            (doc["rawPath"], doc["raw"]),
        ):
            if key in files:
                raise ValueError("Colliding generated page path: " + key)
            files[key] = contents
    return files, provenance


def output_location(repo, output):
    location = Path(output).expanduser().absolute()
    if location.resolve().is_relative_to(repo.resolve()):
        raise ValueError("Generated documentation must be outside the Git checkout")
    return location


def build_site(output, files):
    if output.exists() or output.is_symlink():
        raise ValueError("Output already exists; choose an empty destination")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".readme-site-stage-", dir=output.parent))
    try:
        for relative, data in files.items():
            target = staging.joinpath(*PurePosixPath(relative).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        os.rename(staging, output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def check_site(output, files):
    if not output.is_dir() or output.is_symlink():
        raise ValueError("Generated documentation site missing or unsafe")
    actual = {}
    for node in output.rglob("*"):
        if node.is_symlink():
            raise ValueError("Generated site contains a symlink")
        if node.is_file():
            actual[node.relative_to(output).as_posix()] = node.read_bytes()
    expected, present = set(files), set(actual)
    if expected != present:
        raise ValueError(
            f"Generated site inventory differs: missing={sorted(expected - present)!r}; "
            f"extra={sorted(present - expected)!r}")
    for path, content in files.items():
        if actual[path] != content:
            raise ValueError("Generated site source or HTML drift: " + path)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "check"))
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--repository", required=True, help="Pinned GitHub owner/name")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        repo = args.repo_root.resolve(strict=True)
        output = output_location(repo, args.output)
        files, evidence = build_files(repo, args.repository)
        if args.command == "build":
            build_site(output, files)
        else:
            check_site(output, files)
    except (ValueError, OSError) as exc:
        parser.exit(2, f"readme-site: {exc}\n")
    print(f"{args.command.upper()}: {evidence['documentCount']} Git README pages, "
          f"build {evidence['buildId']}, revision {evidence['sourceCommit']} "
          f"at {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
