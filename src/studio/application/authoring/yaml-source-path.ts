import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  type Node
} from "yaml";
import type {
  YamlSourceDiagnostic,
  YamlValuePath
} from "./yaml-source-types.js";

export type ResolvedYamlPath = {
  readonly ok: true;
  readonly node: Node;
};

export type UnresolvedYamlPath = {
  readonly ok: false;
  readonly diagnostic: YamlSourceDiagnostic;
};

export type ResolveYamlPathResult = ResolvedYamlPath | UnresolvedYamlPath;

function pathDiagnostic(
  code: YamlSourceDiagnostic["code"],
  message: string,
  path: YamlValuePath
): UnresolvedYamlPath {
  return {
    ok: false,
    diagnostic: { severity: "error", code, message, path }
  };
}

export function validateYamlValuePath(
  path: YamlValuePath
): YamlSourceDiagnostic | undefined {
  if (!Array.isArray(path) || path.length === 0) {
    return {
      severity: "error",
      code: "yaml_path_invalid",
      message: "A YAML value path must contain at least one segment.",
      path
    };
  }

  for (const segment of path) {
    if (
      typeof segment !== "string" &&
      !(
        typeof segment === "number" &&
        Number.isSafeInteger(segment) &&
        segment >= 0
      )
    ) {
      return {
        severity: "error",
        code: "yaml_path_invalid",
        message:
          "YAML path segments must be string keys or non-negative integer indexes.",
        path
      };
    }
  }

  return undefined;
}

export function resolveYamlValuePath(
  root: Node | null,
  path: YamlValuePath
): ResolveYamlPathResult {
  if (root === null) {
    return pathDiagnostic(
      "yaml_path_not_found",
      "The YAML document is empty.",
      path
    );
  }

  let current: Node = root;

  for (const segment of path) {
    if (isAlias(current)) {
      return pathDiagnostic(
        "yaml_path_alias_unsupported",
        "YAML paths cannot traverse aliases because their source is indirect.",
        path
      );
    }

    if (isMap(current)) {
      if (typeof segment !== "string") {
        return pathDiagnostic(
          "yaml_path_type_mismatch",
          "A YAML mapping requires a string key path segment.",
          path
        );
      }

      const pair = current.items.find(
        (item) => isScalar(item.key) && item.key.value === segment
      );
      if (pair === undefined || !isNode(pair.value)) {
        return pathDiagnostic(
          "yaml_path_not_found",
          `YAML mapping key ${JSON.stringify(segment)} was not found.`,
          path
        );
      }
      current = pair.value;
      continue;
    }

    if (isSeq(current)) {
      if (typeof segment !== "number") {
        return pathDiagnostic(
          "yaml_path_type_mismatch",
          "A YAML sequence requires a numeric index path segment.",
          path
        );
      }

      const item = current.items[segment];
      if (!isNode(item)) {
        return pathDiagnostic(
          "yaml_path_not_found",
          `YAML sequence index ${segment} was not found.`,
          path
        );
      }
      current = item;
      continue;
    }

    return pathDiagnostic(
      "yaml_path_type_mismatch",
      "The YAML path attempts to traverse a scalar value.",
      path
    );
  }

  if (isAlias(current)) {
    return pathDiagnostic(
      "yaml_path_alias_unsupported",
      "Replacing an alias is unsupported because its value source is indirect.",
      path
    );
  }

  return { ok: true, node: current };
}
