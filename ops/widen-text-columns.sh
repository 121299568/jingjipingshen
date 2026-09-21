#!/bin/bash
# 扩长「自由文本」列，消除「任一列超长 → 整行 REPLACE 失败 → 静默丢明细」隐患
# 背景：spec 曾报 Data too long for column 'spec'，与 workItems 缺列那次是同一失败模式。
# 只做长度放大（VARCHAR(n) → VARCHAR(m), m>n），不改类型、不丢数据，表都很小，瞬时完成。
set -u
DB=economic_review
PW='Kton01DYIWsS6kuQRGt4YYTJ'
Q() { mysql -N -B -u review_app -p"$PW" "$DB" -e "$1" 2>/dev/null; }

echo "== 变更前 =="
Q "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA='$DB' AND (
     (TABLE_NAME='procurementItems' AND COLUMN_NAME IN ('spec','supplier')) OR
     (TABLE_NAME='travelItems'      AND COLUMN_NAME='purpose') OR
     (TABLE_NAME='workItems'        AND COLUMN_NAME='work_task') OR
     (TABLE_NAME IN ('expertEstimates','confirmations') AND COLUMN_NAME='comment'))
   ORDER BY TABLE_NAME, COLUMN_NAME"
echo
echo "== 行数（变更前）=="
Q "SELECT 'procurementItems', COUNT(*) FROM procurementItems
   UNION ALL SELECT 'travelItems', COUNT(*) FROM travelItems
   UNION ALL SELECT 'workItems', COUNT(*) FROM workItems"

echo
echo "== 执行 ALTER =="
Q "ALTER TABLE procurementItems
     MODIFY spec     VARCHAR(1024) DEFAULT NULL,
     MODIFY supplier VARCHAR(255)  DEFAULT NULL" && echo "  procurementItems ok"
Q "ALTER TABLE travelItems     MODIFY purpose   VARCHAR(255) DEFAULT NULL" && echo "  travelItems ok"
Q "ALTER TABLE workItems       MODIFY work_task VARCHAR(255) DEFAULT NULL" && echo "  workItems ok"
Q "ALTER TABLE expertEstimates MODIFY comment   VARCHAR(512) DEFAULT NULL" && echo "  expertEstimates ok"
Q "ALTER TABLE confirmations   MODIFY comment   VARCHAR(512) DEFAULT NULL" && echo "  confirmations ok"

echo
echo "== 变更后 =="
Q "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA='$DB' AND (
     (TABLE_NAME='procurementItems' AND COLUMN_NAME IN ('spec','supplier')) OR
     (TABLE_NAME='travelItems'      AND COLUMN_NAME='purpose') OR
     (TABLE_NAME='workItems'        AND COLUMN_NAME='work_task') OR
     (TABLE_NAME IN ('expertEstimates','confirmations') AND COLUMN_NAME='comment'))
   ORDER BY TABLE_NAME, COLUMN_NAME"
echo
echo "== 行数（变更后，应与前一致）=="
Q "SELECT 'procurementItems', COUNT(*) FROM procurementItems
   UNION ALL SELECT 'travelItems', COUNT(*) FROM travelItems
   UNION ALL SELECT 'workItems', COUNT(*) FROM workItems"
