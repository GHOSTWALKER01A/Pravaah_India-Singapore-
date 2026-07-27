/**
 * Ambient declarations so TypeScript accepts CSS imports used by the web build.
 * `import '@/global.css'` (side-effect) and `import styles from './x.module.css'`.
 */
declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module '*.css';
