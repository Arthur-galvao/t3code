"""Regenerate apps/server/src/skills/bundledSkills.generated.ts from .agents/skills."""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKILLS = {"conselho": ["SKILL.md", "council.json"]}

out = "// Generated from .agents/skills by scripts/sync-bundled-skills.py; edit the skill there, not here.\n"
out += "export const BUNDLED_SKILLS: ReadonlyArray<{\n  readonly name: string;\n  readonly files: Readonly<Record<string, string>>;\n}> = [\n"
for name, files in SKILLS.items():
    out += f"  {{\n    name: {json.dumps(name)},\n    files: {{\n"
    for file in files:
        text = (ROOT / ".agents/skills" / name / file).read_text(encoding="utf8")
        out += f"      {json.dumps(file)}: {json.dumps(text, ensure_ascii=False)},\n"
    out += "    },\n  },\n"
out += "];\n"
(ROOT / "apps/server/src/skills/bundledSkills.generated.ts").write_text(out, encoding="utf8", newline="\n")
