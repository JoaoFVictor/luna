import { z } from "zod";

export const BinaryAssetRefSchema = z.object({
  id: z.string().min(1),
  uri: z.string().min(1),
  node_id: z.string().min(1),
  media_type: z.string().min(1),
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  size_bytes: z.number().int().safe().positive()
}).strict();

export type BinaryAssetRef = z.infer<typeof BinaryAssetRefSchema>;

export const NodeBinaryAssetChannelSchema = z.object({
  produced: z.array(BinaryAssetRefSchema).max(128),
  forwarded: z.array(BinaryAssetRefSchema).max(128)
}).strict();

export type NodeBinaryAssetChannel = z.infer<
  typeof NodeBinaryAssetChannelSchema
>;

const NODE_OUTPUT_WITH_BINARY_ASSETS = Symbol("luna.node-output.binary-assets");

/**
 * An in-process execution envelope. The runtime unwraps it before validating
 * or projecting the public node output and persists the binary asset channel
 * beside that output in the node durability record.
 */
export type NodeOutputWithBinaryAssets<T> = {
  readonly [NODE_OUTPUT_WITH_BINARY_ASSETS]: true;
  readonly output: T;
  readonly binary_assets: NodeBinaryAssetChannel;
};

export function nodeOutputWithBinaryAssets<T>(
  output: T,
  binaryAssets: NodeBinaryAssetChannel
): NodeOutputWithBinaryAssets<T> {
  return {
    [NODE_OUTPUT_WITH_BINARY_ASSETS]: true,
    output,
    binary_assets: binaryAssets
  };
}

export function unwrapNodeOutputWithBinaryAssets(value: unknown): {
  readonly output: unknown;
  readonly binary_assets?: NodeBinaryAssetChannel;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    !(NODE_OUTPUT_WITH_BINARY_ASSETS in value) ||
    value[NODE_OUTPUT_WITH_BINARY_ASSETS] !== true
  ) {
    return { output: value };
  }
  const envelope = value as NodeOutputWithBinaryAssets<unknown>;
  return { output: envelope.output, binary_assets: envelope.binary_assets };
}
