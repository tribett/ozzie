import tseslint from "typescript-eslint";
export default tseslint.config(...tseslint.configs.recommended, { ignores: ["**/dist/**", "core/mcp/dist-share/**", "**/node_modules/**", "**/target/**"] });
