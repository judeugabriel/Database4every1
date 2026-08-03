# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Windows installer

Build the NSIS Windows installer:

```sh
npm run installer:windows
```

The installer is written to `src-tauri/target/release/bundle/nsis/`.

An MSI package can also be built with:

```sh
npm run installer:windows:msi
```

Windows builds require the Tauri prerequisites: Node.js, Rust, and Microsoft Visual Studio C++ build tools.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
