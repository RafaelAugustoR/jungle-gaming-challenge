# Repository Guidelines

## Project Status & Structure

This workspace is currently empty: no application code, tests, assets, dependency manifest, or Git metadata is present. No framework or language has been selected. Keep this guide aligned with the implementation as the project develops.

When adding the initial application, use a clear layout appropriate to the chosen stack. Suggested locations are `src/` for application code, `tests/` for tests, `assets/` for static resources, and `docs/` for supporting documentation. These directories are recommendations, not existing paths. Group related functionality together and avoid unnecessary scaffolding.

## Build, Test, and Development Commands

No build, test, lint, or development commands are configured yet. Do not assume commands such as `npm test` or `make build` work.

When introducing tooling, document exact installation, local development, build, and test commands in `README.md`. Declare dependencies in the appropriate manifest and commit the lockfile when the selected package manager uses one.

## Coding Style & Naming Conventions

Follow the chosen language’s standard conventions and configure its formatter and linter early. Use consistent indentation within each file and descriptive names for modules, functions, and variables. Match file names to their purpose and the selected framework’s conventions. Keep changes focused; avoid unrelated formatting edits.

## Testing Guidelines

No test framework or coverage threshold is established. Add suitable tests alongside new behavior, including failure cases and boundary conditions. Use descriptive test names that identify the behavior and expected result. Document test discovery conventions and execution commands when a framework is introduced.

## Commit & Pull Request Guidelines

There is no Git history from which to infer commit conventions. Use short, imperative commit subjects, such as `Add initial game model`, and keep each commit focused on one change.

Pull requests should explain the change, its purpose, and validation performed. Link relevant issues when available and include screenshots for visual changes. Explicitly note checks that could not be run.

## Security & Configuration

Keep credentials and local configuration out of version control. Provide placeholder configuration examples and document required environment variables when configuration is introduced.
