# 測試帳號與可見功能對照表

本文件對應 [`Deploy.js`](/Users/kih/Library/CloudStorage/OneDrive-Personal/文件/HR_managerv3/Deploy.js)、[`AuthService.js`](/Users/kih/Library/CloudStorage/OneDrive-Personal/文件/HR_managerv3/AuthService.js) 與 [`js/router.html`](/Users/kih/Library/CloudStorage/OneDrive-Personal/文件/HR_managerv3/js/router.html) 的目前設定。

## 使用方式

1. 先在測試用 Spreadsheet 執行 `deployWithSampleData()`
2. 用下列帳號登入 Web App
3. 確認左側選單是否只顯示該角色可見功能
4. 再進一步驗證頁面內的新增、修改、刪除或匯出操作

## 測試帳號總表

| 測試帳號 | 預期角色 | 角色判斷依據 | 預期可見頁面 |
|---|---|---|---|
| `e002@example.org` | `ADMIN` | Sheet 3 職稱含「執行長」 | 儀表板、人員管理、職務配置、組織架構、駐站管理員、RACI 查詢、我的責任、稽核驗證 |
| `e008@example.org` | `HR` | Sheet 3 `orgCode = GRP-ADMIN` | 儀表板、人員管理、職務配置、組織架構、駐站管理員、RACI 查詢、我的責任 |
| `e009@example.org` | `AUDITOR` | Sheet 3 `orgCode` 包含 `TF-GRP-AUDIT` | 儀表板、人員管理、職務配置、組織架構、駐站管理員、RACI 查詢、我的責任、稽核驗證 |
| `e010@example.org` | `MGR` | 有下屬 `e011` 的 `managerEmail = e010@example.org` | 儀表板、人員管理、組織架構、駐站管理員、RACI 查詢、我的責任 |
| `e011@example.org` | `STAFF` | 不符合更高權限條件 | 儀表板、人員管理、組織架構、RACI 查詢、我的責任 |
| `ext.vendor@example.org` | `EXTERNAL` | email 以 `ext.` 開頭 | RACI 查詢、我的責任 |

## 角色驗證重點

### ADMIN
- 可看見全部選單。
- 應可執行 `personnel.write`、`personnel.delete`、`org.write`、`assignment.write`、`audit.run`、`audit.export`。

### HR
- 可看見稽核以外的大多數管理頁面。
- 應可新增或修改人員、組織、職務配置，但不可刪除人員，不可進入稽核驗證。

### AUDITOR
- 可進入稽核驗證。
- 可查看人員與職務配置，但不應有新增、修改、刪除權限。

### MGR
- 可看見部門儀表板與人員管理。
- 不應看見職務配置與稽核驗證。
- 人員管理預期為部門範圍，而非全員資料。

### STAFF
- 可看見個人儀表板、人員管理、組織架構、RACI 相關頁面。
- 不應看見職務配置、駐站管理員、稽核驗證。
- 人員管理預期僅能查看自己資料。

### EXTERNAL
- 僅應看見 `RACI 查詢` 與 `我的責任`。
- 不應看見儀表板、人事、組織、駐站、稽核相關頁面。

## 功能權限矩陣

### 頁面與查詢權限

| 功能 | 對應權限 | ADMIN | HR | AUDITOR | MGR | STAFF | EXTERNAL |
|---|---|---|---|---|---|---|---|
| 儀表板（全域） | `dashboard.full` | Y | Y | Y | - | - | - |
| 儀表板（部門） | `dashboard.dept` | - | - | - | Y | - | - |
| 儀表板（個人） | `dashboard.personal` | - | - | - | - | Y | - |
| 人員管理（全員） | `personnel.read.all` | Y | Y | Y | - | - | - |
| 人員管理（部門） | `personnel.read.dept` | - | - | - | Y | - | - |
| 人員管理（本人） | `personnel.read.self` | - | - | - | - | Y | - |
| 組織架構 | `org.read` | Y | Y | Y | Y | Y | - |
| 職務配置 | `assignment.read.all` | Y | Y | Y | - | - | - |
| RACI 查詢 | `raci.read` | Y | Y | Y | Y | Y | Y |
| 我的責任 | `raci.read` | Y | Y | Y | Y | Y | Y |
| RACI 角色對照表 | `rolemap.read` | Y | Y | Y | - | - | - |
| 駐站管理員 | `station.read` | Y | Y | Y | Y | - | - |
| 稽核驗證 | `audit.run` | Y | - | Y | - | - | - |

### 寫入與匯出權限

| 功能 | read | write | delete | export | ADMIN | HR | AUDITOR | MGR | STAFF | EXTERNAL |
|---|---|---|---|---|---|---|---|---|---|---|
| 人員管理 | `personnel.read.*` | `personnel.write` | `personnel.delete` | - | 全員/可寫/可刪 | 全員/可寫/不可刪 | 全員/唯讀 | 部門/唯讀 | 本人/唯讀 | 無 |
| 組織架構 | `org.read` | `org.write` | - | - | 可讀可寫 | 可讀可寫 | 唯讀 | 唯讀 | 唯讀 | 無 |
| 職務配置 | `assignment.read.all` | `assignment.write` | - | - | 可讀可寫 | 可讀可寫 | 唯讀 | 無 | 無 | 無 |
| RACI 查詢 / 我的責任 | `raci.read` | - | - | - | 唯讀 | 唯讀 | 唯讀 | 唯讀 | 唯讀 | 唯讀 |
| RACI 角色對照表 | `rolemap.read` | - | - | - | 唯讀 | 唯讀 | 唯讀 | 無 | 無 | 無 |
| 駐站管理員 | `station.read` | - | - | - | 唯讀 | 唯讀 | 唯讀 | 唯讀 | 無 | 無 |
| 稽核驗證 | `audit.run` | - | - | `audit.export` | 可執行/可匯出 | 無 | 可執行/可匯出 | 無 | 無 | 無 |

### 測試判讀說明

- `Y` 代表該角色應看得到該頁面或可進入該功能。
- `唯讀` 代表可進入頁面，但不應出現新增、修改、刪除、匯出等操作能力。
- `部門/唯讀` 與 `本人/唯讀` 代表資料範圍受限，測試時應確認不是全資料可見。
- `audit.run` 控制是否可進入稽核頁面，`audit.export` 另外控制是否可匯出稽核結果。

## 補充

- `e003@example.org`、`e004@example.org`、`e005@example.org` 也都會被判定為 `ADMIN`，可作為備用高權限帳號。
- `e006@example.org`、`e007@example.org` 也會是 `STAFF`，可作為一般員工備用帳號。
- 若測試結果與預期不符，優先檢查 Sheet 1、Sheet 3 資料是否重複 append，或 Session 快取是否仍保留舊角色。
