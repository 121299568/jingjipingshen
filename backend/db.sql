-- 经济评审管理系统数据库设计

-- 用户表
CREATE TABLE users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    real_name VARCHAR(50),
    email VARCHAR(100),
    phone VARCHAR(20),
    role ENUM('admin', 'biz', 'rd', 'expert', 'accountant') NOT NULL,
    department VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

-- 评审批次表
CREATE TABLE review_sessions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    session_name VARCHAR(200) NOT NULL,
    session_code VARCHAR(50) UNIQUE NOT NULL,
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

-- 项目表
CREATE TABLE projects (
    id INT PRIMARY KEY AUTO_INCREMENT,
    project_name VARCHAR(200) NOT NULL,
    project_code VARCHAR(50) UNIQUE,
    biz_department VARCHAR(100),
    rd_department VARCHAR(100),
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

-- 项目资料表
CREATE TABLE project_files (
    id INT PRIMARY KEY AUTO_INCREMENT,
    project_id INT NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    file_type VARCHAR(50),
    file_size BIGINT,
    uploader_id INT,
    upload_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_public BOOLEAN DEFAULT FALSE,
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

-- 评审意见批注表
CREATE TABLE review_comments (
    id INT PRIMARY KEY AUTO_INCREMENT,
    session_id INT NOT NULL,
    project_id INT NOT NULL,
    expert_id INT NOT NULL,
    page_number INT,
    content TEXT NOT NULL,
    comment_type ENUM('text', 'highlight', 'stamping', 'annotation') DEFAULT 'text',
    x_position DECIMAL(5,2),
    y_position DECIMAL(5,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES review_sessions(id),
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (expert_id) REFERENCES users(id)
);

-- 工作流记录表
CREATE TABLE workflow_logs (
    id INT PRIMARY KEY AUTO_INCREMENT,
    project_id INT NOT NULL,
    from_role VARCHAR(50),
    to_role VARCHAR(50),
    action VARCHAR(100),
    operator_id INT,
    remark TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (operator_id) REFERENCES users(id)
);

-- AI分析记录表
CREATE TABLE ai_analysis_results (
    id INT PRIMARY KEY AUTO_INCREMENT,
    project_id INT NOT NULL,
    analysis_type VARCHAR(50),
    input_data JSON,
    output_summary TEXT,
    suggestions JSON,
    model_version VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- 定时任务表
CREATE TABLE scheduled_tasks (
    id INT PRIMARY KEY AUTO_INCREMENT,
    task_name VARCHAR(100) NOT NULL,
    task_type VARCHAR(50),
    cron_expression VARCHAR(50),
    last_run_at TIMESTAMP,
    next_run_at TIMESTAMP,
    is_enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 系统配置表
CREATE TABLE system_config (
    id INT PRIMARY KEY AUTO_INCREMENT,
    config_key VARCHAR(100) UNIQUE NOT NULL,
    config_value TEXT,
    description VARCHAR(255),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 初始化数据
INSERT INTO users (username, password, real_name, role, department) VALUES
('admin', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', '系统管理员', 'admin', 'IT部'),
('biz_dept', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', '事业部代表', 'biz', '各事业部'),
('rd_staff', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', '研发中心员工', 'rd', '研发中心'),
('expert01', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', '评审专家A', 'expert', '评审专家库'),
('expert02', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', '评审专家B', 'expert', '评审专家库'),
('accountant', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', '会计师', 'accountant', '外部会计师事务所');

-- 系统配置
INSERT INTO system_config (config_key, config_value, description) VALUES
('review_score_weight_workload', '0.4', '工作量权重'),
('review_score_weight_quality', '0.3', '质量权重'),
('review_score_weight_difficulty', '0.2', '难度权重'),
('review_score_weight_innovation', '0.1', '创新权重'),
('ai_analysis_enabled', 'true', '是否启用AI分析'),
('max_file_upload_size', '100MB', '最大上传文件大小');
