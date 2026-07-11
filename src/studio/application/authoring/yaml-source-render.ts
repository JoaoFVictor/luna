import YAML, {
  isCollection,
  type Document,
  type Node,
  type ParsedNode
} from "yaml";
import type { JsonValue } from "../../../core/json/value.js";

function detectedLineEnding(source: string, target: string): string {
  const targetEnding = target.match(/(?:\r\n|\n|\r)$/u)?.[0];
  if (targetEnding !== undefined) {
    return targetEnding;
  }
  return source.match(/\r\n|\n|\r/u)?.[0] ?? "\n";
}

function lineStartOffset(source: string, offset: number): number {
  const lf = source.lastIndexOf("\n", Math.max(0, offset - 1));
  const cr = source.lastIndexOf("\r", Math.max(0, offset - 1));
  return Math.max(lf, cr) + 1;
}

function stripDocumentEnding(source: string): string {
  return source.endsWith("\n") ? source.slice(0, -1) : source;
}

export function renderYamlReplacement(
  document: Document.Parsed<ParsedNode>,
  target: Node,
  source: string,
  startOffset: number,
  endOffset: number,
  value: JsonValue
): string {
  const replacementDocument = new YAML.Document(value, {
    version: document.directives.yaml.version
  });
  if (isCollection(replacementDocument.contents)) {
    replacementDocument.contents.flow =
      !isCollection(target) || target.flow === true;
  }

  const targetSource = source.slice(startOffset, endOffset);
  const lineEnding = detectedLineEnding(source, targetSource);
  const indentation = " ".repeat(
    startOffset - lineStartOffset(source, startOffset)
  );
  const rendered = stripDocumentEnding(
    replacementDocument.toString({ lineWidth: 0 })
  ).replace(/\n/gu, `${lineEnding}${indentation}`);

  const consumedLineEnding = targetSource.match(/(?:\r\n|\n|\r)$/u)?.[0];
  return consumedLineEnding === undefined
    ? rendered
    : `${rendered}${consumedLineEnding}`;
}
