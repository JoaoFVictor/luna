import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../src/core/json/value.js";
import {
  replaceYamlValueAtPath,
  type YamlValuePath
} from "../../src/studio/application/authoring/index.js";

const fixtures = path.join(
  process.cwd(),
  "tests/studio/fixtures/yaml-source-editor"
);

const structurallyDifferentReplacements: readonly {
  readonly label: string;
  readonly source: string;
  readonly path: YamlValuePath;
  readonly value: JsonValue;
  readonly expected: unknown;
}[] = [
  {
    label: "block map with scalar",
    source: "value:\n  left: 1\n  right: 2\nafter: kept\n",
    path: ["value"],
    value: "done",
    expected: { value: "done", after: "kept" }
  },
  {
    label: "block sequence with another block sequence",
    source: "value:\n  - first\n  - second\nafter: kept\n",
    path: ["value"],
    value: ["third", "fourth"],
    expected: { value: ["third", "fourth"], after: "kept" }
  },
  {
    label: "flow map with another map",
    source: "value: { left: 1, right: 2 } # kept\n",
    path: ["value"],
    value: { replacement: true },
    expected: { value: { replacement: true } }
  },
  {
    label: "map inside a block sequence",
    source: "values:\n  - left: 1\n    right: 2\nafter: kept\n",
    path: ["values", 0],
    value: { replacement: true, count: 2 },
    expected: {
      values: [{ replacement: true, count: 2 }],
      after: "kept"
    }
  },
  {
    label: "block scalar with a boolean",
    source: "value: |\n  first\n  second\nafter: kept\n",
    path: ["value"],
    value: false,
    expected: { value: false, after: "kept" }
  }
];

describe("Studio YAML source editor", () => {
  it("is byte-identical when the requested value is unchanged", async () => {
    const source = await readFile(
      path.join(fixtures, "workflow.input.yaml"),
      "utf8"
    );

    const result = replaceYamlValueAtPath({
      source,
      path: ["nodes", 0, "retry", "attempts"],
      value: 2
    });

    expect(result).toMatchObject({ ok: true, changed: false, source });
    expect(result.source).toBe(source);
  });

  it("matches the golden file while changing only the target range", async () => {
    const source = await readFile(
      path.join(fixtures, "workflow.input.yaml"),
      "utf8"
    );
    const expected = await readFile(
      path.join(fixtures, "workflow.expected.yaml"),
      "utf8"
    );

    const result = replaceYamlValueAtPath({
      source,
      path: ["nodes", 0, "retry", "attempts"],
      value: 4
    });

    expect(result).toMatchObject({ ok: true, changed: true, source: expected });
    if (!result.ok || !result.changed) {
      throw new Error("Expected a successful YAML text edit");
    }
    const { start, end } = result.edit.range;
    expect(source.slice(0, start.offset)).toBe(
      result.source.slice(0, start.offset)
    );
    expect(source.slice(end.offset)).toBe(
      result.source.slice(start.offset + result.edit.replacement.length)
    );
    expect(result.edit.replacement).toBe("4");
    expect(result.targetRange).toEqual({
      start: { offset: start.offset, line: 10, column: 17 },
      end: { offset: end.offset, line: 10, column: 18 }
    });
  });

  it("replaces a block collection without reformatting its surroundings", () => {
    const source = [
      "metadata:",
      "  labels:",
      "    owner: platform # removed with replaced collection",
      "    tier: one",
      "tail: untouched # preserved",
      ""
    ].join("\n");

    const result = replaceYamlValueAtPath({
      source,
      path: ["metadata", "labels"],
      value: { owner: "studio", tier: "two" }
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(result.source).toBe([
      "metadata:",
      "  labels:",
      "    owner: studio",
      "    tier: two",
      "tail: untouched # preserved",
      ""
    ].join("\n"));
  });

  it("uses a flow collection when replacing an inline scalar", () => {
    const source = "input: old # keep\nafter: next\n";

    const result = replaceYamlValueAtPath({
      source,
      path: ["input"],
      value: { branch: "main", checks: ["test", "lint"] }
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(result.source).toBe(
      "input: { branch: main, checks: [ test, lint ] } # keep\nafter: next\n"
    );
    expect(YAML.parse(result.source)).toEqual({
      input: { branch: "main", checks: ["test", "lint"] },
      after: "next"
    });
  });

  it.each(structurallyDifferentReplacements)(
    "keeps $label replacements structurally valid",
    ({
      source,
      path: valuePath,
      value,
      expected
    }) => {
      const result = replaceYamlValueAtPath({
        source,
        path: valuePath,
        value
      });

      expect(result).toMatchObject({ ok: true, changed: true });
      expect(YAML.parse(result.source)).toEqual(expected);
    }
  );

  it("preserves CRLF bytes around a multiline scalar replacement", () => {
    const source = "name: old\r\nnext: untouched\r\n";

    const result = replaceYamlValueAtPath({
      source,
      path: ["name"],
      value: "first\nsecond"
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(result.source).toBe(
      "name: |-\r\n      first\r\n      second\r\nnext: untouched\r\n"
    );
    expect(YAML.parse(result.source)).toEqual({
      name: "first\nsecond",
      next: "untouched"
    });
  });

  it("returns located syntax diagnostics without changing source", () => {
    const source = "nodes: [broken\n";

    const result = replaceYamlValueAtPath({
      source,
      path: ["nodes"],
      value: []
    });

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      source,
      diagnostics: [
        {
          severity: "error",
          code: "yaml_parse_error",
          range: {
            start: expect.objectContaining({ line: 2, column: 1 })
          }
        }
      ]
    });
  });

  it("rejects missing paths, aliases, and implicit empty values safely", () => {
    const missing = replaceYamlValueAtPath({
      source: "root:\n  value: 1\n",
      path: ["root", "missing"],
      value: 2
    });
    expect(missing).toMatchObject({
      ok: false,
      changed: false,
      diagnostics: [{ code: "yaml_path_not_found" }]
    });

    const alias = replaceYamlValueAtPath({
      source: "base: &base\n  value: 1\ncopy: *base\n",
      path: ["copy", "value"],
      value: 2
    });
    expect(alias).toMatchObject({
      ok: false,
      changed: false,
      diagnostics: [{ code: "yaml_path_alias_unsupported" }]
    });

    const empty = replaceYamlValueAtPath({
      source: "value:\nnext: kept\n",
      path: ["value"],
      value: "filled"
    });
    expect(empty).toMatchObject({
      ok: false,
      changed: false,
      targetRange: {
        start: expect.objectContaining({ line: 1, column: 7 }),
        end: expect.objectContaining({ line: 1, column: 7 })
      },
      diagnostics: [
        {
          code: "yaml_target_unsafe",
          range: expect.any(Object)
        }
      ]
    });
  });

  it("rejects an edit that would leave an alias outside the target dangling", () => {
    const source = [
      "root:",
      "  nested: &shared",
      "    value: kept",
      "use: *shared",
      ""
    ].join("\n");

    const result = replaceYamlValueAtPath({
      source,
      path: ["root"],
      value: { replacement: true }
    });

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      source,
      diagnostics: [{ code: "yaml_parse_error" }]
    });
    expect(result.source).toBe(source);
  });

  it("quotes values according to the parsed YAML version", () => {
    const source = "%YAML 1.1\n---\nvalue: old\n";

    const result = replaceYamlValueAtPath({
      source,
      path: ["value"],
      value: "yes"
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(result.source).toBe("%YAML 1.1\n---\nvalue: \"yes\"\n");
    expect(YAML.parse(result.source)).toEqual({ value: "yes" });
  });
});
