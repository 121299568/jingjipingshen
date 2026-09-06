-- 经济评审管理系统 —— MySQL 表结构
-- 字符集 utf8mb4；引擎 InnoDB。
-- 时间戳字段统一用 VARCHAR(32) 存 ISO 字符串，避免时区/格式转换坑，应用侧自行解析。
-- 布尔用 TINYINT(1)（0/1）。金额/数量用 DOUBLE，ID 用 INT。
-- 每张表额外有一个 extra JSON 列，用于承载应用层写入的“未预定义字段”，绝不静默丢失数据。
-- 注意：db.mysql.js 的 ensureSchema() 会在服务启动时自动按本结构建表（CREATE TABLE IF NOT EXISTS），
--       因此生产部署通常无需手动执行本文件；本文件仅作参考与离线初始化之用。

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `users` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(64) NOT NULL,
  `password` VARCHAR(255) NOT NULL,
  `real_name` VARCHAR(64) NOT NULL DEFAULT '',
  `role` VARCHAR(32) NOT NULL DEFAULT 'rd',
  `department` VARCHAR(64) NOT NULL DEFAULT '',
  `business_dept` VARCHAR(64) DEFAULT NULL,
  `created_at` VARCHAR(32) DEFAULT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `extra` JSON DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `reviewSessions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(128) NOT NULL DEFAULT '',
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `review_time` VARCHAR(64) DEFAULT NULL,
  `creator_id` INT DEFAULT NULL,
  `note` VARCHAR(255) DEFAULT NULL,
  `created_at` VARCHAR(32) DEFAULT NULL,
  `extra` JSON DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `projects` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `project_name` VARCHAR(255) NOT NULL DEFAULT '',
  `project_code` VARCHAR(64) DEFAULT NULL,
  `project_type` VARCHAR(64) DEFAULT NULL,
  `business_direction` VARCHAR(64) DEFAULT NULL,
  `product_direction` VARCHAR(64) DEFAULT NULL,
  `is_digital` TINYINT(1) NOT NULL DEFAULT 0,
  `business_sub_direction` VARCHAR(64) DEFAULT NULL,
  `contract_amount` DOUBLE NOT NULL DEFAULT 0,
  `biz_department` VARCHAR(64) DEFAULT NULL,
  `session_id` INT DEFAULT NULL,
  `description` TEXT,
  `contract_party` VARCHAR(255) DEFAULT NULL,
  `remark` TEXT,
  `status` VARCHAR(32) NOT NULL DEFAULT 'draft',
  `created_at` VARCHAR(32) DEFAULT NULL,
  `creator_id` INT DEFAULT NULL,
  `updated_at` VARCHAR(32) DEFAULT NULL,
  `extra` JSON DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_biz_department` (`biz_department`),
  KEY `idx_session_id` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `workItems` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `project_id` INT DEFAULT NULL,
  `work_task` VARCHAR(128) DEFAULT NULL,
  `work_item` VARCHAR(255) DEFAULT NULL,
  `category` VARCHAR(32) DEFAULT NULL,
  `cost` DOUBLE NOT NULL DEFAULT 0,
  `person_days` DOUBLE NOT NULL DEFAULT 0,
  `unit_price` DOUBLE NOT NULL DEFAULT 0,
  `quantity` DOUBLE NOT NULL DEFAULT 0,
  `remark` VARCHAR(255) DEFAULT NULL,
  `extra` JSON DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_project_id` (`project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `procurementItems` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `project_id` INT DEFAULT NULL,
  `item_name` VARCHAR(255) DEFAULT NULL,
  `spec` VARCHAR(128) DEFAULT NULL,
  `amount` DOUBLE NOT NULL DEFAULT 0,
  `supplier` VARCHAR(128) DEFAULT NULL,
  `remark` VARCHAR(255) DEFAULT NULL,
  `extra` JSON DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_project_id` (`project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `travelItems` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `project_id` INT DEFAULT NULL,
  `purpose` VARCHAR(128) DEFAULT NULL,
  `person` VARCHAR(64) DEFAULT NULL,
  `days` DOUBLE NOT NULL DEFAULT 0,
  `amount` DOUBLE NOT NULL DEFAULT 0,
  `remark` VARCHAR(255) DEFAULT NULL,
  `extra` JSON DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_project_id` (`project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `expertEstimates` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `project_id` INT DEFAULT NULL,
  `work_item_id` INT DEFAULT NULL,
  `expert_id` INT DEFAULT NULL,
  `expert_name` VARCHAR(64) DEFAULT NULL,
  `days` DOUBLE NOT NULL DEFAULT 0,
  `comment` VARCHAR(255) DEFAULT NULL,
  `created_at` VARCHAR(32) DEFAULT NULL,
  `extra` JSON DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_project_id` (`project_id`),
  KEY `idx_expert_id` (`expert_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `confirmations` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `project_id` INT DEFAULT NULL,
  `work_item_id` INT DEFAULT NULL,
  `expert_id` INT DEFAULT NULL,
  `expert_name` VARCHAR(64) DEFAULT NULL,
  `confirmed` TINYINT(1) NOT NULL DEFAULT 0,
  `comment` VARCHAR(255) DEFAULT NULL,
  `created_at` VARCHAR(32) DEFAULT NULL,
  `extra` JSON DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_project_id` (`project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `files` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `project_id` INT DEFAULT NULL,
  `filename` VARCHAR(255) DEFAULT NULL,
  `originalname` VARCHAR(255) DEFAULT NULL,
  `file_seq` INT DEFAULT NULL,
  `file_type` VARCHAR(16) DEFAULT NULL,
  `file_category` VARCHAR(32) DEFAULT NULL,
  `auto_detected` TINYINT(1) NOT NULL DEFAULT 0,
  `uploader_id` INT DEFAULT NULL,
  `uploader_name` VARCHAR(64) DEFAULT NULL,
  `description` VARCHAR(255) DEFAULT NULL,
  `upload_time` VARCHAR(32) DEFAULT NULL,
  `extra` JSON DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_project_id` (`project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `workflowLogs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `project_id` INT DEFAULT NULL,
  `operator_id` INT DEFAULT NULL,
  `operator_role` VARCHAR(32) DEFAULT NULL,
  `operator_name` VARCHAR(64) DEFAULT NULL,
  `action` VARCHAR(64) DEFAULT NULL,
  `remark` VARCHAR(255) DEFAULT NULL,
  `created_at` VARCHAR(32) DEFAULT NULL,
  `extra` JSON DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_project_id` (`project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `userGroups` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(128) NOT NULL DEFAULT '',
  `description` VARCHAR(255) DEFAULT NULL,
  `created_at` VARCHAR(32) DEFAULT NULL,
  `extra` JSON DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `userPermissions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `user_id` INT NOT NULL DEFAULT 0,
  `permissions` JSON DEFAULT NULL,
  `extra` JSON DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
