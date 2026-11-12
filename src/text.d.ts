// Markdown imported `with { type: "text" }` (core/docs.ts).
declare module "*.md" {
  const text: string;
  export default text;
}

// Shell scripts aug installs (core/install.ts), embedded the same way so a
// compiled binary carries them.
declare module "*.sh" {
  const text: string;
  export default text;
}
