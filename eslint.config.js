import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**"] },
  ...tseslint.configs.recommended,
  {
    // NFR-ARC-03: the Parking Exchange Engine is a discrete component.
    // No I/O, HTTP, ORM or framework import may enter packages/engine.
    files: ["packages/engine/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["pg", "pg-*", "@nestjs/*", "express", "fastify", "kysely", "drizzle-orm", "@prisma/*", "react", "react-*"], message: "packages/engine must stay framework-free (NFR-ARC-03)." },
            { group: ["node:*", "fs", "path", "http", "https", "net", "crypto"], message: "packages/engine must not do I/O (NFR-ARC-03)." },
            { group: ["@availo/*"], message: "packages/engine depends on nothing else in the repo." },
          ],
        },
      ],
    },
  },
);
