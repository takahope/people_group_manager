/**
 * Code.gs — HR 管理系統主入口
 * 職責：doGet() 路由分派、Session 管理
 * 
 * 設計原則：
 * - 本檔案只做「入口」與「路由」，不包含業務邏輯
 * - 業務邏輯各由 AuthService / DataService / *API 負責
 */

// =============================================
// 常數定義
// =============================================

/** @const {string} 試算表 ID（請替換為實際 Spreadsheet ID） */
const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID_HERE';

/** @const {Object} Sheet 索引對應名稱 */
const SHEET_NAMES = {
  PERSONNEL: '人員主檔',      // Sheet 1
  ORG:       '組織架構樹',    // Sheet 2
  ASSIGNMENT:'人員職務配置',   // Sheet 3
  RACI:      'RACI矩陣主表',  // Sheet 4
  ROLE_MAP:  'RACI角色對照表',// Sheet 5
  AUDIT_LOG: '操作日誌',      // 操作紀錄
};

// =============================================
// Web App 入口
// =============================================

/**
 * GAS Web App 入口函式
 * 負責身份驗證後，回傳對應角色的 UI 殼層
 * 
 * @param {Object} e - doGet 事件物件
 * @returns {HtmlOutput} 渲染後的 HTML 頁面
 */
function doGet(e) {
  try {
    // 通行碼關卡：在身份驗證之前檢查，未設定/未通過/已過期一律阻擋（無角色例外）
    const gateResult = parseServiceResponse(AuthService.getPasscodeGateStatus());
    if (!gateResult.success) {
      Logger.log('doGet 通行碼關卡檢查失敗：' + (gateResult.error || '未知錯誤'));
      return buildErrorPage(
        gateResult.error || '無法識別您的身份，請確認您已登入組織 Google 帳號。'
      );
    }
    if (!gateResult.data.configured) {
      return buildPasscodeSetupRequiredPage();
    }
    if (!gateResult.data.verified) {
      return buildPasscodeLoginPage();
    }

    const userInfoResult = parseServiceResponse(AuthService.getCurrentUser());

    // 身份驗證失敗：回傳無權限頁面
    if (!userInfoResult.success) {
      Logger.log('doGet 使用者驗證失敗：' + (userInfoResult.error || '未知錯誤'));
      return buildErrorPage(
        userInfoResult.error || '無法識別您的身份，請確認您已登入組織 Google 帳號。'
      );
    }

    // 回傳主殼層，並將使用者資訊傳遞給前端
    const template = HtmlService.createTemplateFromFile('index');
    template.userInfo = JSON.stringify(userInfoResult.data);
    return template.evaluate()
      .setTitle('HR 管理系統')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  } catch (error) {
    Logger.log('doGet 錯誤：' + (error.stack || error.message));
    return buildErrorPage('系統發生錯誤，請稍後再試。');
  }
}

/**
 * 包含外部 HTML 檔案（styles / js）到主模板
 * 供 index.html 使用 <?!= include('styles') ?>
 * 
 * @param {string} filename - 要包含的檔案名稱（不含 .html）
 * @returns {string} 檔案內容字串
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// =============================================
// 輔助函式
// =============================================

/**
 * 建立錯誤頁面
 * 
 * 提取此輔助函式以降低 doGet 的認知複雜度
 * @param {string} message - 錯誤訊息
 * @returns {HtmlOutput}
 */
function buildErrorPage(message) {
  const html = `
    <!DOCTYPE html>
    <html lang="zh-Hant">
    <head>
      <meta charset="UTF-8">
      <title>存取錯誤 — HR 管理系統</title>
      <style>
        body { font-family: sans-serif; display: flex; align-items: center;
               justify-content: center; height: 100vh; margin: 0; background: #f5f5f5; }
        .box { text-align: center; background: white; padding: 2rem 3rem;
               border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,.15); }
        h2 { color: #c0392b; }
        p  { color: #555; }
      </style>
    </head>
    <body>
      <div class="box">
        <h2>🔒 存取受限</h2>
        <p>${message}</p>
        <p>如有問題，請聯繫系統管理員。</p>
      </div>
    </body>
    </html>`;
  return HtmlService.createHtmlOutput(html).setTitle('存取受限');
}

/**
 * 通行碼輸入頁 — 已設定通行碼但使用者尚未通過驗證/驗證已過期時顯示
 * @returns {HtmlOutput}
 */
function buildPasscodeLoginPage() {
  const template = HtmlService.createTemplateFromFile('passcode');
  template.mode = 'input';
  return template.evaluate()
    .setTitle('通行碼驗證 — HR 管理系統')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 通行碼未設定提示頁 — Script Property 尚未設定時顯示，阻擋所有角色（含 ADMIN）
 * @returns {HtmlOutput}
 */
function buildPasscodeSetupRequiredPage() {
  const template = HtmlService.createTemplateFromFile('passcode');
  template.mode = 'not_configured';
  return template.evaluate()
    .setTitle('系統尚未設定通行碼 — HR 管理系統')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 取得綁定的 Spreadsheet（集中管理，方便日後替換）
 * 
 * @returns {Spreadsheet}
 */
function getSpreadsheet() {
  return resolveSpreadsheetBinding_().spreadsheet;
}

/**
 * 解析目前實際使用中的 Spreadsheet 與來源。
 *
 * @returns {{
 *   spreadsheet: Spreadsheet,
 *   source: 'bound'|'id_fallback',
 *   configuredSpreadsheetId: string,
 *   boundSpreadsheetId: string,
 *   fallbackSpreadsheetId: string,
 * }}
 */
function resolveSpreadsheetBinding_() {
  const active = getBoundSpreadsheet_();
  const configuredSpreadsheetId = String(SPREADSHEET_ID || '').trim();
  const hasConfiguredId = configuredSpreadsheetId && configuredSpreadsheetId !== 'YOUR_SPREADSHEET_ID_HERE';

  if (active) {
    return {
      spreadsheet: active,
      source: 'bound',
      configuredSpreadsheetId,
      boundSpreadsheetId: active.getId(),
      fallbackSpreadsheetId: hasConfiguredId ? configuredSpreadsheetId : '',
    };
  }

  if (!hasConfiguredId) {
    throw new Error('此專案未綁定 Google Sheet，且尚未設定有效的 SPREADSHEET_ID');
  }

  return {
    spreadsheet: SpreadsheetApp.openById(configuredSpreadsheetId),
    source: 'id_fallback',
    configuredSpreadsheetId,
    boundSpreadsheetId: '',
    fallbackSpreadsheetId: configuredSpreadsheetId,
  };
}

/**
 * 取得指定工作表
 * 
 * @param {string} sheetName - SHEET_NAMES 中的值
 * @returns {Sheet}
 */
function getSheet(sheetName) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(`找不到工作表：${sheetName}`);
  return sheet;
}

/**
 * 將結果包裝為統一的成功回應格式
 * 
 * @param {*} data
 * @returns {string} JSON 字串
 */
function successResponse(data) {
  return JSON.stringify({ success: true, data });
}

/**
 * 將錯誤包裝為統一的失敗回應格式
 * 
 * @param {string} message
 * @returns {string} JSON 字串
 */
function errorResponse(message) {
  return JSON.stringify({ success: false, error: message });
}

/**
 * 將服務層回傳值標準化為物件。
 *
 * 供 doGet 這類伺服器端直接呼叫共用函式使用，避免把 JSON 字串誤當物件。
 * @param {string|Object} result
 * @returns {{success:boolean, data?:*, error?:string}}
 */
function parseServiceResponse(result) {
  if (typeof result === 'string') {
    return JSON.parse(result);
  }
  return result;
}

/**
 * 優先取得綁定於目前 Apps Script 專案的 Spreadsheet。
 *
 * 在容器綁定專案中使用預設 Sheet；獨立專案則回傳 null，由呼叫者決定 fallback。
 * @returns {Spreadsheet|null}
 */
function getBoundSpreadsheet_() {
  try {
    return SpreadsheetApp.getActiveSpreadsheet() || null;
  } catch (error) {
    Logger.log('getBoundSpreadsheet_ 無法取得綁定試算表：' + error.message);
    return null;
  }
}

/**
 * 將目前程式實際綁定的 Spreadsheet 資訊寫入 execution logs。
 *
 * 用途：排查 Web App 與預期 Google Sheet 不一致的問題。
 */
function logSpreadsheetBindingInfo() {
  const binding = resolveSpreadsheetBinding_();
  const ss = binding.spreadsheet;
  const info = {
    source: binding.source,
    spreadsheet: {
      id: ss.getId(),
      name: ss.getName(),
      url: ss.getUrl(),
    },
    configuredSpreadsheetId: binding.configuredSpreadsheetId || '',
    boundSpreadsheetId: binding.boundSpreadsheetId || '',
    fallbackSpreadsheetId: binding.fallbackSpreadsheetId || '',
    idsMatch: binding.configuredSpreadsheetId
      ? binding.configuredSpreadsheetId === ss.getId()
      : null,
  };
  const payload = JSON.stringify(info);

  Logger.log('Spreadsheet binding info: ' + payload);
  console.log('Spreadsheet binding info: ' + payload);
}
