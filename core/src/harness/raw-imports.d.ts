// Vite (desktop build) and vitest both load `?raw` imports as the file's text: the skill files and the
// fixed texts in ./fixed. This tells TypeScript so.
declare module "*.md?raw" {
  const content: string;
  export default content;
}
declare module "*.txt?raw" {
  const content: string;
  export default content;
}
declare module "*.json?raw" {
  const content: string;
  export default content;
}
