#!/usr/bin/env python3
"""Build perturbed two-agent cases from SWE-bench Lite gold patches, with labels.

Agent A = the instance's gold patch (a real upstream fix).
Agent B = a synthetic concurrent edit written against the BASE version of the
same repository, of one of four kinds:

  K1s  stale caller of a callable A changed the signature of (or deleted)
  K1b  stale caller of a callable A changed only the body of
  K2   caller of a callable in A's file that A did not touch
  K3   shadow: B defines and calls its own function with the same name as a
       callable A changed, without importing A's module
  K4   intra-file: B appends a new function to A's file that calls a callable
       A changed (signature-changed if any, else body-changed)

Labels come from an oracle that is independent of the Switchyard filter: it
parses A's post-patch file with CPython's own `ast`, builds an
`inspect.Signature` for the called symbol, and tries to bind B's call
arguments to it. A bind failure, or a missing symbol, means the merged program
would break at that call site although each branch is fine alone (B's call
binds against the base signature: asserted). This is an interface-level
ground truth: behavioural changes behind a compatible signature are labelled
"no conflict", which is the limit of any static pre-merge filter.

Stdlib only. Usage:
  python scripts/p3/perturb.py            # writes <cache>/cases.jsonl
  python scripts/p3/perturb.py --selftest
"""

from __future__ import annotations

import ast
import hashlib
import inspect
import json
import os
import re
import subprocess
import sys
import tempfile
import warnings
from pathlib import Path

SENTINEL = object()
warnings.filterwarnings("ignore", category=SyntaxWarning)  # old escape sequences in upstream sources


def cache_dir() -> Path:
    root = os.environ.get("SWITCHYARD_P3_CACHE") or str(Path.home() / ".cache" / "switchyard-p3")
    return Path(root)


def seeded(*parts: str) -> int:
    return int(hashlib.sha256("|".join(parts).encode()).hexdigest()[:8], 16)


# --------------------------------------------------------------------------
# Patch application (git apply as a plain patch tool, no repository needed)
# --------------------------------------------------------------------------

def apply_patch(base_text: str, rel_path: str, patch: str) -> str | None:
    with tempfile.TemporaryDirectory() as d:
        target = Path(d) / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base_text.encode("utf-8"))
        pf = Path(d) / "gold.patch"
        pf.write_bytes(patch.encode("utf-8"))
        r = subprocess.run(["git", "apply", "--whitespace=nowarn", str(pf)], cwd=d, capture_output=True)
        if r.returncode != 0:
            return None
        return target.read_bytes().decode("utf-8")


# --------------------------------------------------------------------------
# Callables and signatures
# --------------------------------------------------------------------------

def deco_names(fn: ast.AST) -> list[str]:
    out = []
    for d in getattr(fn, "decorator_list", []):
        node = d.func if isinstance(d, ast.Call) else d
        if isinstance(node, ast.Name):
            out.append(node.id)
        elif isinstance(node, ast.Attribute):
            out.append(node.attr)
    return out


def callables(tree: ast.Module) -> dict[str, dict]:
    """Public top-level functions, methods of top-level classes, and constructors."""
    out: dict[str, dict] = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("_"):
            out[node.name] = {"node": node, "kind": "function", "class": None}
        elif isinstance(node, ast.ClassDef) and not node.name.startswith("_"):
            for item in node.body:
                if not isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                decos = deco_names(item)
                if "property" in decos or "setter" in decos or "overload" in decos:
                    continue
                if item.name == "__init__":
                    out[node.name] = {"node": item, "kind": "constructor", "class": node.name}
                elif not item.name.startswith("_"):
                    kind = "staticmethod" if "staticmethod" in decos else "classmethod" if "classmethod" in decos else "method"
                    out[f"{node.name}.{item.name}"] = {"node": item, "kind": kind, "class": node.name}
    return out


def signature_of(entry: dict) -> inspect.Signature:
    a = entry["node"].args
    params: list[inspect.Parameter] = []
    posonly = list(a.posonlyargs)
    normal = list(a.args)
    defaults = [SENTINEL] * (len(posonly) + len(normal) - len(a.defaults)) + list(a.defaults)
    allpos = [(p, inspect.Parameter.POSITIONAL_ONLY) for p in posonly] + [
        (p, inspect.Parameter.POSITIONAL_OR_KEYWORD) for p in normal
    ]
    for (p, kind), dflt in zip(allpos, defaults):
        params.append(inspect.Parameter(p.arg, kind, default=inspect.Parameter.empty if dflt is SENTINEL else None))
    if a.vararg:
        params.append(inspect.Parameter(a.vararg.arg, inspect.Parameter.VAR_POSITIONAL))
    for p, d in zip(a.kwonlyargs, a.kw_defaults):
        params.append(inspect.Parameter(p.arg, inspect.Parameter.KEYWORD_ONLY, default=inspect.Parameter.empty if d is None else None))
    if a.kwarg:
        params.append(inspect.Parameter(a.kwarg.arg, inspect.Parameter.VAR_KEYWORD))
    # Bound receiver: drop self/cls.
    if entry["kind"] in ("method", "classmethod", "constructor") and params:
        params = params[1:]
    return inspect.Signature(params)


def header_dump(entry: dict) -> str:
    n = entry["node"]
    return ast.dump(n.args) + "|" + ",".join(deco_names(n)) + "|" + entry["kind"]


def body_dump(entry: dict) -> str:
    return ast.dump(ast.Module(body=entry["node"].body, type_ignores=[]))


# --------------------------------------------------------------------------
# Calls written against the base signature
# --------------------------------------------------------------------------

def make_call_args(sig: inspect.Signature, seed: int) -> tuple[list[str], dict[str, str]]:
    pos: list[str] = []
    kw: dict[str, str] = {}
    optional = []
    for p in sig.parameters.values():
        if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
            continue
        required = p.default is inspect.Parameter.empty
        if required and p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD):
            pos.append("None")
        elif required:
            kw[p.name] = "None"
        elif p.kind != p.POSITIONAL_ONLY:
            optional.append(p.name)
    if optional and seed % 2 == 0:
        kw[optional[seed // 2 % len(optional)]] = "None"
    return pos, kw


def call_expr(callee: str, pos: list[str], kw: dict[str, str]) -> str:
    return f"{callee}({', '.join(pos + [f'{k}={v}' for k, v in kw.items()])})"


def binds(sig: inspect.Signature, pos: list[str], kw: dict[str, str]) -> bool:
    try:
        sig.bind(*pos, **kw)
        return True
    except TypeError:
        return False


def module_of(path: str) -> str:
    p = path[:-3] if path.endswith(".py") else path
    if p.endswith("/__init__"):
        p = p[: -len("/__init__")]
    return p.replace("/", ".")


def consumer_snippet(name: str, entry: dict, pos: list[str], kw: dict[str, str]) -> tuple[str, str]:
    """(import-free body defining fleet_b_probe, the top-level name to import)."""
    cls = entry["class"]
    if entry["kind"] == "function":
        return f"def fleet_b_probe():\n    return {call_expr(name, pos, kw)}\n", name
    if entry["kind"] == "constructor":
        return f"def fleet_b_probe():\n    return {call_expr(cls, pos, kw)}\n", cls
    meth = name.split(".", 1)[1]
    if entry["kind"] in ("staticmethod", "classmethod"):
        return f"def fleet_b_probe():\n    return {call_expr(f'{cls}.{meth}', pos, kw)}\n", cls
    return f"def fleet_b_probe(obj: {cls}):\n    return {call_expr(f'obj.{meth}', pos, kw)}\n", cls


def oracle(name: str, base_entry: dict, post_calls: dict[str, dict], pos, kw) -> tuple[bool, str]:
    post = post_calls.get(name)
    if post is None:
        return True, "symbol removed or made private"
    if post["kind"] != base_entry["kind"]:
        return True, f"call shape changed ({base_entry['kind']} -> {post['kind']})"
    if not binds(signature_of(post), pos, kw):
        return True, f"call no longer binds: {signature_of(base_entry)} -> {signature_of(post)}"
    return False, "call still binds"


# --------------------------------------------------------------------------
# Contract mutations layered on top of A's gold patch
# --------------------------------------------------------------------------

BREAKING_MUTATIONS = ("add_required", "remove_last", "make_kwonly", "rename_first", "delete")
COMPATIBLE_MUTATIONS = ("add_optional", "add_varkw", "default_required")
RECEIVER_KINDS = ("method", "classmethod", "constructor")


def mutate(post_text: str, name: str, mutation: str) -> str | None:
    """Apply one signature mutation to `name` in post_text; None if not applicable."""
    entry = callables(ast.parse(post_text)).get(name)
    if entry is None:
        return None
    node = entry["node"]
    lines = post_text.splitlines(keepends=True)
    if mutation == "delete":
        start = (node.decorator_list[0].lineno if node.decorator_list else node.lineno) - 1
        out = "".join(lines[:start] + lines[node.end_lineno:])
    else:
        a = node.args
        allpos = list(a.posonlyargs) + list(a.args)
        receiver = 1 if entry["kind"] in RECEIVER_KINDS and allpos else 0
        first_default = len(allpos) - len(a.defaults)
        if mutation == "add_required":
            if a.vararg or a.defaults:
                a.kwonlyargs.append(ast.arg("fleet_new"))
                a.kw_defaults.append(None)
            else:
                a.args.append(ast.arg("fleet_new"))
        elif mutation == "add_optional":
            if a.vararg:
                a.kwonlyargs.append(ast.arg("fleet_opt"))
                a.kw_defaults.append(ast.Constant(None))
            else:
                a.args.append(ast.arg("fleet_opt"))
                a.defaults.append(ast.Constant(None))
        elif mutation == "add_varkw":
            if a.kwarg:
                return None
            a.kwarg = ast.arg("fleet_kw")
        elif mutation == "remove_last":
            if a.vararg or a.kwarg or len(a.args) == 0 or len(allpos) <= receiver:
                return None
            gi = len(allpos) - 1
            a.args.pop()
            if gi >= first_default:
                a.defaults.pop()
        elif mutation == "make_kwonly":
            if a.vararg or a.posonlyargs:
                return None
            keep = receiver + 1  # receiver plus first real parameter stay positional
            if len(a.args) <= keep:
                return None
            defaults = [None] * (len(a.args) - len(a.defaults)) + list(a.defaults)
            moved, moved_d = a.args[keep:], defaults[keep:]
            a.args, kept_d = a.args[:keep], defaults[:keep]
            a.defaults = [d for d in kept_d if d is not None]
            a.kwonlyargs = list(moved) + list(a.kwonlyargs)
            a.kw_defaults = list(moved_d) + list(a.kw_defaults)
        elif mutation == "rename_first":
            if len(a.args) == 0 or len(allpos) <= receiver or a.posonlyargs:
                return None
            a.args[receiver].arg += "_renamed"
        elif mutation == "default_required":
            if a.posonlyargs or first_default <= receiver:
                return None
            a.defaults.insert(0, ast.Constant(None))
            # one more default -> the last required param becomes optional
        else:
            raise ValueError(mutation)
        line_start = sum(len(x) for x in lines[: node.lineno - 1]) + node.col_offset
        open_at = post_text.index("(", post_text.index(node.name, line_start))
        depth, close_at = 0, -1
        for k in range(open_at, len(post_text)):
            ch = post_text[k]
            if ch in "([{":
                depth += 1
            elif ch in ")]}":
                depth -= 1
                if depth == 0:
                    close_at = k
                    break
        if close_at < 0:
            return None
        out = post_text[: open_at + 1] + ast.unparse(a) + post_text[close_at:]
    try:
        ast.parse(out)
    except SyntaxError:
        return None
    return out


# --------------------------------------------------------------------------
# Case generation
# --------------------------------------------------------------------------

def build_cases(row: dict, root: Path) -> tuple[list[dict], str | None]:
    paths = re.findall(r"^diff --git a/(\S+) b/", row["patch"], re.M)
    if len(paths) != 1 or not paths[0].endswith(".py"):
        return [], "not a single .py file"
    rel = paths[0]
    base_file = root / "files" / row["instance_id"] / rel
    if not base_file.exists():
        return [], "base file missing"
    base_text = base_file.read_bytes().decode("utf-8")
    post_text = apply_patch(base_text, rel, row["patch"])
    if post_text is None:
        return [], "gold patch does not apply"
    try:
        base_tree, post_tree = ast.parse(base_text), ast.parse(post_text)
    except SyntaxError:
        return [], "syntax error under CPython 3.13"
    post_dir = root / "post" / row["instance_id"] / rel
    post_dir.parent.mkdir(parents=True, exist_ok=True)
    post_dir.write_bytes(post_text.encode("utf-8"))

    bc, pc = callables(base_tree), callables(post_tree)
    sig_changed = sorted(n for n, e in bc.items() if n not in pc or header_dump(e) != header_dump(pc[n]))
    body_changed = sorted(
        n for n, e in bc.items() if n in pc and header_dump(e) == header_dump(pc[n]) and body_dump(e) != body_dump(pc[n])
    )
    untouched = sorted(n for n, e in bc.items() if n in pc and ast.dump(e["node"]) == ast.dump(pc[n]["node"]))
    module = module_of(rel)
    pkg_dir = rel.rsplit("/", 1)[0] if "/" in rel else ""
    b_path = f"{pkg_dir}/fleet_b_probe.py" if pkg_dir else "fleet_b_probe.py"
    iid = row["instance_id"]
    cases: list[dict] = []

    def pick(names: list[str], tag: str) -> str | None:
        return names[seeded(iid, tag) % len(names)] if names else None

    gold_post_rel = post_dir.relative_to(root).as_posix()

    def add(kind, name, b_mode, b_content, label, reason, pos, kw, a_post=None, mutation=None):
        cases.append({
            "id": f"{iid}::{kind}" + (f"::{mutation}" if mutation else ""),
            "a_post_file": a_post or gold_post_rel,
            "mutation": mutation,
            "instance_id": iid,
            "repo": row["repo"],
            "kind": kind,
            "provider_path": rel,
            "symbol": name,
            "symbol_kind": bc[name]["kind"],
            "label": label,
            "oracle": reason,
            "b_mode": b_mode,
            "b_path": rel if b_mode == "append" else b_path,
            "b_content": b_content,
            "call": {"pos": pos, "kw": kw},
        })

    def stale_caller(kind: str, name: str):
        e = bc[name]
        sig = signature_of(e)
        pos, kw = make_call_args(sig, seeded(iid, kind, name))
        assert binds(sig, pos, kw), (iid, name)
        body, top = consumer_snippet(name, e, pos, kw)
        label, reason = oracle(name, e, pc, pos, kw)
        add(kind, name, "new", f"from {module} import {top}\n\n\n{body}", label, reason, pos, kw)

    for kind, pool in (("K1s", sig_changed), ("K1b", body_changed), ("K2", untouched)):
        n = pick(pool, kind)
        if n:
            stale_caller(kind, n)

    target = pick(sig_changed, "K3") or pick(body_changed, "K3")
    if target:
        leaf = target.split(".")[-1] if bc[target]["kind"] != "constructor" else bc[target]["class"]
        body = f"def {leaf}(*args, **kwargs):\n    return None\n\n\ndef fleet_b_probe():\n    return {leaf}(None)\n"
        add("K3", target, "new", body, False, "shadowing local definition, no import", [], {})

    target = pick(sig_changed, "K4") or pick(body_changed, "K4")
    if target:
        e = bc[target]
        sig = signature_of(e)
        pos, kw = make_call_args(sig, seeded(iid, "K4", target))
        body, _ = consumer_snippet(target, e, pos, kw)
        label, reason = oracle(target, e, pc, pos, kw)
        sep = "" if base_text.endswith("\n") else "\n"
        add("K4", target, "append", base_text + sep + "\n\n" + body, label, reason, pos, kw)

    # M-cases: A = gold patch + one contract mutation of a symbol A's fix
    # already touched (else an untouched one); B = a caller written against
    # the base. One breaking-family and one compatible-family mutation per
    # instance; the oracle, not the family name, decides the label.
    target = pick(body_changed or untouched, "M")
    if target:
        e = bc[target]
        sig = signature_of(e)
        pos, kw = make_call_args(sig, seeded(iid, "M", target))
        body, top = consumer_snippet(target, e, pos, kw)
        for family, muts in (("Mb", BREAKING_MUTATIONS), ("Mc", COMPATIBLE_MUTATIONS)):
            for mutation in sorted(muts, key=lambda m: seeded(iid, family, m)):
                mutated = mutate(post_text, target, mutation)
                if mutated is None:
                    continue
                mpath = root / "post" / f"{iid}@{mutation}" / rel
                mpath.parent.mkdir(parents=True, exist_ok=True)
                mpath.write_bytes(mutated.encode("utf-8"))
                mrel = mpath.relative_to(root).as_posix()
                label, reason = oracle(target, e, callables(ast.parse(mutated)), pos, kw)
                add(family, target, "new", f"from {module} import {top}\n\n\n{body}", label, reason, pos, kw, mrel, mutation)
                if family == "Mb":
                    sep = "" if base_text.endswith("\n") else "\n"
                    add("Mb-intra", target, "append", base_text + sep + "\n\n" + body, label, reason, pos, kw, mrel, mutation)
                break
    return cases, None


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    root = cache_dir()
    rows = json.loads((root / "lite.json").read_text(encoding="utf-8"))
    out = root / "cases.jsonl"
    skipped: dict[str, int] = {}
    n = 0
    with out.open("w", encoding="utf-8") as fh:
        for row in rows:
            cases, why = build_cases(row, root)
            if why:
                skipped[why] = skipped.get(why, 0) + 1
            for c in cases:
                fh.write(json.dumps(c) + "\n")
                n += 1
    print(json.dumps({"instances": len(rows), "cases": n, "skipped": skipped}))
    return 0


def selftest() -> int:
    base = "def f(a, b=1):\n    return a\n\nclass C:\n    def __init__(self, x):\n        pass\n    def m(self, y):\n        return y\n"
    post = "def f(a, b=1, c=2):\n    return a\n\nclass C:\n    def __init__(self, x, z):\n        pass\n    def m(self, y, *, k):\n        return y\n"
    bc, pc = callables(ast.parse(base)), callables(ast.parse(post))
    assert oracle("f", bc["f"], pc, ["None"], {}) == (False, "call still binds")
    assert oracle("C", bc["C"], pc, ["None"], {})[0] is True  # new required z
    assert oracle("C.m", bc["C.m"], pc, ["None"], {})[0] is True  # new required kw-only k
    assert oracle("f", bc["f"], {}, ["None"], {})[0] is True  # removed
    src = "class C:\n    def m(self, a, b=2):\n        return a\n\ndef g(x, y):\n    return x\n"
    assert "def g(x, y, fleet_new)" in mutate(src, "g", "add_required")
    assert "def m(self, a, *, b=2)" in mutate(src, "C.m", "make_kwonly")
    assert "def m(self, a)" in mutate(src, "C.m", "remove_last")
    assert "def g(x, y=None)" in mutate(src, "g", "default_required")
    assert "def g" not in mutate(src, "g", "delete")
    print("selftest ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
