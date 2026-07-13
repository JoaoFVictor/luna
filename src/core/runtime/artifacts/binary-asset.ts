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

