/**
 * SheetColumns.gs — 集中管理 Google Sheet 欄位索引
 *
 * 規則：
 * - 所有 row[] / data[i][] 存取一律使用 0-based 索引
 * - 所有 getRange(row, col, ...) 的欄號一律使用 1-based
 */

const ROLE_ENTITY_TYPES = new Set(['PERSON', 'GROUP', 'RULE', 'EXTERNAL']);

const COL = {
  PERSONNEL: {
    EMAIL: 0,
    NAME: 1,
    ASSET_GROUP_CODE: 2,
    ASSET_GROUP_NAME: 3,
  },
  ORG: {
    TYPE: 0,
    LEVEL: 1,
    CODE: 2,
    NAME: 3,
    ALIAS: 4,
    PARENT_CODE: 5,
    MANAGER_EMAIL: 6,
    MANAGER_NAME: 7,
  },
  ASSIGNMENT: {
    EMAIL: 0,
    NAME: 1,
    ORG_CODE: 2,
    ORG_NAME: 3,
    TITLE: 4,
    MANAGER_EMAIL: 5,
    MANAGER_NAME: 6,
  },
  RACI: {
    TASK_CODE: 0,
    TASK_NAME: 1,
    ITEM_CODE: 2,
    ITEM_NAME: 3,
    R: 4,
    A: 5,
    C: 6,
    I: 7,
    NOTE: 8,
  },
  ROLE_MAP: {
    ROLE_CODE: 0,
    ROLE_NAME: 1,
    ENTITY_TYPE: 2,
    ENTITY_ID: 3,
  },
  AUDIT_LOG: {
    TIMESTAMP: 0,
    OPERATOR_EMAIL: 1,
    ACTION: 2,
    TARGET: 3,
    DETAILS: 4,
  },
};

function col1(zeroBasedIndex) {
  return zeroBasedIndex + 1;
}

function widthFromColMap(colMap) {
  return Math.max.apply(null, Object.keys(colMap).map(key => colMap[key])) + 1;
}

/**
 * 相容舊版 RACI 角色對照表：
 * - 新版 schema: [角色代碼, 角色名稱, 對應實體類型, 對應實體ID/說明]
 * - 舊版 schema: [角色代碼, 角色名稱, entityId, 說明]
 */
function normalizeRoleMapRow(row) {
  const entityType = row[COL.ROLE_MAP.ENTITY_TYPE];
  const entityId = row[COL.ROLE_MAP.ENTITY_ID];

  if (ROLE_ENTITY_TYPES.has(entityType)) {
    return {
      roleCode: row[COL.ROLE_MAP.ROLE_CODE],
      roleName: row[COL.ROLE_MAP.ROLE_NAME],
      entityType,
      entityId: entityId || '',
      description: '',
    };
  }

  return {
    roleCode: row[COL.ROLE_MAP.ROLE_CODE],
    roleName: row[COL.ROLE_MAP.ROLE_NAME],
    entityType: '',
    entityId: entityType || '',
    description: entityId || '',
  };
}
