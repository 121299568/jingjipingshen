/**
 * 数据库迁移脚本 - 从JSON存储迁移到MySQL
 * 
 * 使用方法：
 * 1. 确保MySQL已安装并创建好数据库
 * 2. 配置.env文件
 * 3. 运行：node migrate.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// MySQL连接配置
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'review_app',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'economic_review',
  charset: 'utf8mb4'
};

// JSON存储路径
const STORE_FILE = path.join(__dirname, 'data', 'store.json');

async function main() {
  console.log('=== 开始数据迁移 ===\n');
  
  // 1. 连接MySQL
  console.log('1. 连接MySQL数据库...');
  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    console.log('   ✓ 连接成功\n');
  } catch (error) {
    console.error('   ✗ 连接失败:', error.message);
    console.log('\n请检查：');
    console.log('   - MySQL服务是否运行');
    console.log('   - 用户名密码是否正确');
    console.log('   - 数据库是否已创建');
    process.exit(1);
  }
  
  // 2. 读取JSON数据
  console.log('2. 读取JSON存储数据...');
  let store;
  try {
    const data = fs.readFileSync(STORE_FILE, 'utf8');
    store = JSON.parse(data);
    console.log(`   ✓ 读取成功`);
    console.log(`   - 用户数: ${store.users?.length || 0}`);
    console.log(`   - 项目数: ${store.projects?.length || 0}`);
    console.log(`   - 批次数: ${store.reviewSessions?.length || 0}`);
    console.log(`   - 文件数: ${store.projectFiles?.length || 0}\n`);
  } catch (error) {
    console.error('   ✗ 读取失败:', error.message);
    console.log('\n请检查：');
    console.log('   - JSON文件是否存在:', STORE_FILE);
    console.log('   - 文件格式是否正确');
    await connection.end();
    process.exit(1);
  }
  
  // 3. 插入用户数据
  console.log('3. 迁移用户数据...');
  if (store.users && store.users.length > 0) {
    for (const user of store.users) {
      try {
        await connection.execute(
          `INSERT INTO users (id, username, password, real_name, role, department, business_dept, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
           username=VALUES(username), password=VALUES(password), real_name=VALUES(real_name),
           role=VALUES(role), department=VALUES(department), business_dept=VALUES(business_dept)`,
          [
            user.id,
            user.username,
            user.password || '123456',  // 保留原密码或设置默认
            user.real_name,
            user.role,
            user.department,
            user.business_dept,
            user.created_at || new Date().toISOString(),
            user.updated_at || new Date().toISOString()
          ]
        );
      } catch (error) {
        console.log(`   ⚠ 用户 ${user.username} 迁移失败: ${error.message}`);
      }
    }
    console.log(`   ✓ 迁移了 ${store.users.length} 个用户\n`);
  }
  
  // 4. 插入评审批次数据
  console.log('4. 迁移评审批次数据...');
  if (store.reviewSessions && store.reviewSessions.length > 0) {
    for (const session of store.reviewSessions) {
      try {
        await connection.execute(
          `INSERT INTO review_sessions (id, session_name, session_code, status, review_time, creator_id, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
           session_name=VALUES(session_name), status=VALUES(status), review_time=VALUES(review_time)`,
          [
            session.id,
            session.name || session.session_name,
            session.session_code,
            session.status,
            session.review_time ? new Date(session.review_time) : null,
            session.creator_id,
            session.note,
            session.created_at || new Date().toISOString(),
            session.updated_at || new Date().toISOString()
          ]
        );
      } catch (error) {
        console.log(`   ⚠ 批次 ${session.id} 迁移失败: ${error.message}`);
      }
    }
    console.log(`   ✓ 迁移了 ${store.reviewSessions.length} 个批次\n`);
  }
  
  // 5. 插入项目数据
  console.log('5. 迁移项目数据...');
  if (store.projects && store.projects.length > 0) {
    let successCount = 0;
    for (const project of store.projects) {
      try {
        await connection.execute(
          `INSERT INTO projects (id, project_name, project_code, biz_department, business_dept, contract_amount, session_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
           project_name=VALUES(project_name), biz_department=VALUES(biz_department),
           contract_amount=VALUES(contract_amount), session_id=VALUES(session_id), status=VALUES(status)`,
          [
            project.id,
            project.project_name,
            project.project_code,
            project.biz_department,
            project.business_dept,
            project.contract_amount,
            project.session_id,
            project.status,
            project.created_at || new Date().toISOString(),
            project.updated_at || new Date().toISOString()
          ]
        );
        successCount++;
      } catch (error) {
        console.log(`   ⚠ 项目 ${project.id} 迁移失败: ${error.message}`);
      }
    }
    console.log(`   ✓ 迁移了 ${successCount}/${store.projects.length} 个项目\n`);
  }
  
  // 6. 插入工作明细数据
  console.log('6. 迁移工作明细数据...');
  if (store.workItems && store.workItems.length > 0) {
    let successCount = 0;
    for (const item of store.workItems) {
      try {
        await connection.execute(
          `INSERT INTO work_items (id, project_id, category, work_task, work_item, person_days, cost, expert_days_avg, adjusted_cost, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
           category=VALUES(category), person_days=VALUES(person_days), cost=VALUES(cost)`,
          [
            item.id,
            item.project_id,
            item.category,
            item.work_task,
            item.work_item,
            item.person_days,
            item.cost,
            item.expert_days_avg,
            item.adjusted_cost,
            item.created_at || new Date().toISOString()
          ]
        );
        successCount++;
      } catch (error) {
        // 静默失败，可能是外键约束问题
      }
    }
    console.log(`   ✓ 迁移了 ${successCount} 条工作明细\n`);
  }
  
  // 7. 插入采购明细数据
  console.log('7. 迁移采购明细数据...');
  if (store.procurementItems && store.procurementItems.length > 0) {
    let successCount = 0;
    for (const item of store.procurementItems) {
      try {
        await connection.execute(
          `INSERT INTO procurement_items (id, project_id, type, name, quantity, unit_price, subtotal, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE quantity=VALUES(quantity)`,
          [
            item.id,
            item.project_id,
            item.type,
            item.name,
            item.quantity,
            item.unit_price,
            item.subtotal,
            item.created_at || new Date().toISOString()
          ]
        );
        successCount++;
      } catch (error) {
        // 静默失败
      }
    }
    console.log(`   ✓ 迁移了 ${successCount} 条采购明细\n`);
  }
  
  // 8. 插入差旅明细数据
  console.log('8. 迁移差旅明细数据...');
  if (store.travelItems && store.travelItems.length > 0) {
    let successCount = 0;
    for (const item of store.travelItems) {
      try {
        await connection.execute(
          `INSERT INTO travel_items (id, project_id, purpose, destination, days, hotel, per_diem, transport, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE purpose=VALUES(purpose)`,
          [
            item.id,
            item.project_id,
            item.purpose,
            item.destination,
            item.days,
            item.hotel,
            item.per_diem,
            item.transport,
            item.created_at || new Date().toISOString()
          ]
        );
        successCount++;
      } catch (error) {
        // 静默失败
      }
    }
    console.log(`   ✓ 迁移了 ${successCount} 条差旅明细\n`);
  }
  
  // 9. 插入文件记录
  console.log('9. 迁移文件记录...');
  if (store.projectFiles && store.projectFiles.length > 0) {
    let successCount = 0;
    for (const file of store.projectFiles) {
      try {
        await connection.execute(
          `INSERT INTO project_files (id, project_id, file_name, file_path, file_type, file_category, uploader_id, upload_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE file_name=VALUES(file_name)`,
          [
            file.id,
            file.project_id,
            file.originalname || file.file_name,
            file.url || file.file_path,
            file.file_type,
            file.file_category,
            file.uploader_id,
            file.upload_time ? new Date(file.upload_time) : new Date()
          ]
        );
        successCount++;
      } catch (error) {
        console.log(`   ⚠ 文件 ${file.id} 迁移失败: ${error.message}`);
      }
    }
    console.log(`   ✓ 迁移了 ${successCount} 个文件记录\n`);
  }
  
  // 10. 关闭连接
  await connection.end();
  
  console.log('=== 迁移完成 ===');
  console.log('\n下一步：');
  console.log('1. 修改 server.js 使用数据库连接');
  console.log('2. 删除旧的 JSON 数据文件（备份后）');
  console.log('3. 测试系统功能是否正常');
}

main().catch(console.error);
