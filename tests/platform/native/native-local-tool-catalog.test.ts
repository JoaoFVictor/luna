import { describe, expect, it } from "vitest";
import {
  repositoryContextLocalTools
} from "../../../src/capabilities/repository-context/tools.js";
import {
  repositoryToolCatalog
} from "../../../src/capabilities/repository/tool-catalog.js";
import {
  nativeLocalToolCatalog
} from "../../../src/platform/native/native-local-tool-catalog.js";

describe("native local tool catalog", () => {
  it("composes capability-owned catalogs without changing their definitions", () => {
    expect(nativeLocalToolCatalog["repository-context.query"])
      .toBe(repositoryContextLocalTools["repository-context.query"]);
    expect(nativeLocalToolCatalog["repository.read-file"])
      .toBe(repositoryToolCatalog["repository.read-file"]);
    expect(Object.keys(repositoryContextLocalTools).some((id) =>
      Object.hasOwn(repositoryToolCatalog, id)
    )).toBe(false);
  });
});
