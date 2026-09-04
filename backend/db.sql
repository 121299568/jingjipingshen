-- 经济评审管理系统数据库设计 v3（含权限+文件表）

-- 用户表（新增business_dept字段，角色枚举按权限文档扩展）
CREATE TABLE users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    real_name VARCHAR(50),
    email VARCHAR(100),
    phone VARCHAR(20),
    role ENUM('admin', 'biz', 'rd', 'expert', 'accountant') NOT NULL DEFAULT 'expert',
    department VARCHAR(100),
    business_dept VARCHAR(50),  -- 事业部归属：电网/系统集成/电力气象/人工智能/管理/能源
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

-- 评审批次表
CREATE TABLE review_sessions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    session_name VARCHAR(200) NOT NULL,
    session_code VARCHAR(50) UNIQUE,
    status ENUM('pending', 'in_progress', 'completed', 'cancelled') DEFAULT 'pending',
    review_time DATETIME,
    start_time DATETIME,
    end_time DATETIME,
    creator_id INT,
    note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (creator_id) REFERENCES users(id)
);

-- 项目主表（新增business_dept）
CREATE TABLE projects (
    id INT PRIMARY KEY AUTO_INCREMENT,
    project_name VARCHAR(300) NOT NULL,
    project_code VARCHAR(50),
    biz_department VARCHAR(100),
    business_dept VARCHAR(50),       -- 事业部：电网事业部/系统集成事业部等
    rd_department VARCHAR(100),
    project_type VARCHAR(50),
    business_direction VARCHAR(100),
    business_sub_direction VARCHAR(100),
    product_direction VARCHAR(100),
    contract_amount DECIMAL(12,2),
    source_file VARCHAR(255),
    cost_summary JSON,
    submission_date DATE,
    status ENUM('draft', 'submitted', 'pre_review', 'reviewing', 'completed', 'rejected') DEFAULT 'draft',
    reviewer_id INT,
    session_id INT,
    note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (reviewer_id) REFERENCES users(id),
    FOREIGN KEY (session_id) REFERENCES review_sessions(id)
);

-- 工作明细表
CREATE TABLE work_items (
    id INT PRIMARY KEY AUTO_INCREMENT,
    project_id INT NOT NULL,
    category ENUM('long_term', 'zhongshi', 'huazhao', 'outsourcing', 'subcontract'),
    work_task VARCHAR(200),
    work_item VARCHAR(200),
    description TEXT,
    person_days DECIMAL(10,2),
    person VARCHAR(50),
    cost DECIMAL(12,2),
    expert_days JSON,
    expert_days_avg DECIMAL(10,2),
    adjusted_cost DECIMAL(12,2),
    source_sheet VARCHAR(100),
    row_idx INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 采购明细表
CREATE TABLE procurement_items (
    id INT PRIMARY KEY AUTO_INCREMENT,
    project_id INT NOT NULL,
    type ENUM('software', 'hardware'),
    name VARCHAR(200),
    spec TEXT,
    unit VARCHAR(20),
    quantity DECIMAL(12,2),
    unit_price DECIMAL(12,2),
    subtotal DECIMAL(12,2),
    remark VARCHAR(500),
    source_sheet VARCHAR(100),
    row_idx INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 差旅明细表
CREATE TABLE travel_items (
    id INT PRIMARY KEY AUTO_INCREMENT,
    project_id INT NOT NULL,
    purpose VARCHAR(200),
    destination VARCHAR(200),
    days DECIMAL(5,2),
    hotel DECIMAL(10,2),
    per_diem DECIMAL(10,2),
    transport DECIMAL(10,2),
    source_sheet VARCHAR(100),
    row_idx INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 项目评审资料附件表（核心新增）
CREATE TABLE project_files (
    id INT PRIMARY KEY AUTO_INCREMENT,
    project_id INT NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    file_type VARCHAR(50),         -- pdf/docx/xls/jpg/png等
    file_category VARCHAR(50),      -- feasibility/bid/award/contract/profit/subcontract
    uploader_id INT,
    upload_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    description VARCHAR(500),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (uploader_id) REFERENCES users(id)
);

-- 专家评审打分表
CREATE TABLE expert_scores (
    id INT PRIMARY KEY AUTO_INCREMENT,
    session_id INT NOT NULL,
    project_id INT NOT NULL,
    expert_id INT NOT NULL,
    workload_score DECIMAL(5,2),
    quality_score DECIMAL(5,2),
    difficulty_score DECIMAL(5,2),
    innovation_score DECIMAL(5,2),
    total_score DECIMAL(5,2),
    comment TEXT,
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES review_sessions(id),
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (expert_id) REFERENCES users(id)
);

-- 批注表
CREATE TABLE review_comments (
    id INT PRIMARY KEY AUTO_INCREMENT,
    session_id INT NOT NULL,
    project_id INT NOT NULL,
    expert_id INT NOT NULL,
    content TEXT NOT NULL,
    comment_type ENUM('text', 'highlight', 'stamping', 'annotation') DEFAULT 'text',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES review_sessions(id),
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (expert_id) REFERENCES users(id)
);

-- 工作流日志表（全链路操作审计）
CREATE TABLE workflow_logs (
    id INT PRIMARY KEY AUTO_INCREMENT,
    project_id INT NOT NULL,
    session_id INT,
    operator_id INT NOT NULL,
    operator_role VARCHAR(50),
    action VARCHAR(100) NOT NULL,
    from_status VARCHAR(50),
    to_status VARCHAR(50),
    remark TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (operator_id) REFERENCES users(id)
);

-- 系统配置表
CREATE TABLE system_config (
    id INT PRIMARY KEY AUTO_INCREMENT,
    config_key VARCHAR(100) UNIQUE NOT NULL,
    config_value TEXT,
    description VARCHAR(255),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ==================== 初始化数据 ====================

INSERT INTO users (username, password, real_name, role, department, business_dept) VALUES
('admin', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', '系统管理员', 'admin', 'IT部', NULL),
('biz_gdw', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', '电网事业部经办人', 'biz', '电网事业部', '电网事业部'),
('biz_xt', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', '系统集成事业部经办人', 'biz', '系统集成事业部', '系统集成事业部'),
('rd_staff', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', '研发中心员工', 'rd', '研发中心', NULL),
('expert01', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', '评审专家A', 'expert', '评审专家库', NULL),
('expert02', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', '评审专家B', 'expert', '评审专家库', NULL),
('cpa01', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', '会计师事务所专家甲', 'accountant', '外部会计师事务所', NULL);

INSERT INTO review_sessions (session_name, session_code, status, review_time, creator_id) VALUES
('2026年度Q3经济评审', '2026-Q3', 'in_progress', '2026-09-15 09:00:00', 1);

INSERT INTO system_config (config_key, config_value, description) VALUES
('review_score_weight_workload', '0.4', '工作量权重'),
('review_score_weight_quality', '0.3', '质量权重'),
('review_score_weight_difficulty', '0.2', '难度权重'),
('review_score_weight_innovation', '0.1', '创新权重'),
('allowed_file_extensions', 'pdf,docx,xlsx,xls,jpg,png', '允许上传的文件类型'),
('max_upload_size_mb', '50', '单个文件大小限制(MB)');
