import { z } from 'zod';

export const specSchema = z.object({
  adapter: z.enum(['spec-box', 'openspec']),
  'spec-box': z
    .object({
      config: z.string().default('.tms.json'),
      files: z.array(z.string()).optional(),
      newFile: z.string().default('specs/{code}.spec-box.yml'),
    })
    .prefault({}),
  openspec: z.object({ root: z.string().default('openspec') }).prefault({}),
});

export type ContractConfig = { spec: z.infer<typeof specSchema> };
