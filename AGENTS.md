# Repository Guidelines

## Project Structure & Module Organization
This repository is a Google Apps Script web app for HR management. Server-side logic lives in top-level `.gs` files: `Code.gs` is the entry point, `AuthService.gs` and `DataService.gs` provide shared services, and `*API.gs` files expose feature-specific operations such as personnel, org, RACI, dashboard, and audit flows. Frontend assets are template-based: [`index.html`](/Users/kih/Library/CloudStorage/OneDrive-Personal/文件/HR_managerv3/index.html) is the shell, [`styles.html`](/Users/kih/Library/CloudStorage/OneDrive-Personal/文件/HR_managerv3/styles.html) holds shared CSS, and `js/*.html` contains browser-side modules loaded via `include()`. Deployment metadata is in [`appsscript.json`](/Users/kih/Library/CloudStorage/OneDrive-Personal/文件/HR_managerv3/appsscript.json) and [`.clasp.json`](/Users/kih/Library/CloudStorage/OneDrive-Personal/文件/HR_managerv3/.clasp.json).

## Build, Test, and Development Commands
Use `clasp` for local sync with Apps Script:

- `clasp push`: upload local `.gs` and `.html` files to the bound script.
- `clasp pull`: refresh local files from Apps Script before editing shared code.
- `clasp open`: open the bound script project in the browser.

Run one-time setup and demo data from the Apps Script editor:

- `deploySheets()`: create sheet structure only.
- `deployWithSampleData()`: create sheets and append sample data.

## Coding Style & Naming Conventions
Follow the existing style: 2-space indentation, semicolons, `const` by default, and guard clauses over deep nesting. Keep `Code.gs` limited to routing and shared helpers. Put business rules in services or feature APIs, and keep frontend code in the `js/` templates. Use `PascalCase` for service-like globals (`AuthService`), `camelCase` for functions, and `UPPER_SNAKE_CASE` for shared constants like `SHEET_NAMES`.

## Testing Guidelines
There is no automated test suite in this folder. Verify changes by pushing with `clasp`, reloading the web app, and exercising the affected route and role. For sheet-related changes, test against a disposable spreadsheet and use `deploySheets()` or `deployWithSampleData()` to confirm schema assumptions.

## Commit & Pull Request Guidelines
No local `.git` history is available in this directory, so commit conventions cannot be inferred directly here. Use short imperative subjects such as `Fix audit export parsing` or `Add personnel validation`. PRs should describe the affected user flow, list changed GAS entry points, mention required spreadsheet/config updates, and include screenshots for UI changes.

## Security & Configuration Tips
Do not commit real spreadsheet IDs, user data, or production-only credentials. Replace placeholders like `SPREADSHEET_ID` in `Code.gs` per environment, and preserve permission checks in `AuthService.gs` when adding new routes or APIs.

## Incident & Fix Log

- **2026-07-16 Fix Personnel Assignment Supervisor Name Unset Issue**:
  - **Root Cause**: `PersonnelAPI.addAssignment` computed the supervisor name (`managerName`) during matrix concurrency simulation but omitted `managerName` when calling `DataService.appendAssignment(...)`, resulting in empty string (`''`) written to Column G (`MANAGER_NAME`). Upon reload, the UI fell back to displaying "未設定".
  - **Fix**: Updated `addAssignment` to pass `managerName: pendingAssignment.managerName` into `appendAssignment(...)`. Also enhanced `updateAssignment(...)` to ensure `managerName`, `name`, and `orgName` are properly computed and validated during updates.

- **2026-07-17 Filter Resigned Personnel in Assignment Module**:
  - **Root Cause**: `getAssignmentList` returned all Sheet 3 records without checking Sheet 1 status (`status === '離職'`), while `getAssignmentFormOptions` did not filter resigned personnel in `<datalist>`.
  - **Fix**: Updated `PersonnelAPI.js` to filter out `status === '離職'` from Sheet 1 in `getAssignmentList()` and `getAssignmentFormOptions()`. Added validation in `addAssignment()` and `updateAssignment()` to reject target personnel or supervisors whose status is `'離職'`.

