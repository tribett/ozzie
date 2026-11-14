import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["core", "product"].flatMap(root =>
      configDefaults.include.map(pattern => `${root}/${pattern}`)),
  },
});
