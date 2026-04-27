-- User accounts table
CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(50) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'user',
  jab_arm VARCHAR(16) NOT NULL DEFAULT 'right',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Username and email must be unique
  UNIQUE KEY users_username_unique (username),
  UNIQUE KEY users_email_unique (email)
);

-- Active login session tokens
CREATE TABLE IF NOT EXISTS auth_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Token hash uniqueness for lookup
  UNIQUE KEY auth_sessions_token_hash_unique (token_hash),
  KEY auth_sessions_user_id_idx (user_id),
  -- Cascade clean up sessions
  CONSTRAINT auth_sessions_user_id_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Saved analysis sessions
CREATE TABLE IF NOT EXISTS recorded_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  notes TEXT NULL,
  is_favorite TINYINT(1) NOT NULL DEFAULT 0,
  upload_mode VARCHAR(16) NOT NULL,
  session_date VARCHAR(64) NULL,
  total_events INT NOT NULL DEFAULT 0,
  uncertain_events INT NOT NULL DEFAULT 0,
  avg_confidence DECIMAL(6,4) NOT NULL DEFAULT 0,
  model_version VARCHAR(64) NULL,
  -- Aggregated label counts as JSON
  summary_json LONGTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY recorded_sessions_user_id_idx (user_id),
  -- Delete sessions when user removed
  CONSTRAINT recorded_sessions_user_id_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Per-arm uploads inside session
CREATE TABLE IF NOT EXISTS recorded_session_arms (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  recorded_session_id BIGINT UNSIGNED NOT NULL,
  arm VARCHAR(16) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  stored_path VARCHAR(512) NOT NULL,
  source_name VARCHAR(255) NULL,
  session_date VARCHAR(64) NULL,
  duration_sec DECIMAL(10,3) NOT NULL DEFAULT 0,
  total_events INT NOT NULL DEFAULT 0,
  uncertain_events INT NOT NULL DEFAULT 0,
  avg_confidence DECIMAL(6,4) NOT NULL DEFAULT 0,
  model_version VARCHAR(64) NULL,
  -- Per-arm summary and event arrays
  summary_json LONGTEXT NOT NULL,
  events_json LONGTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY recorded_session_arms_session_idx (recorded_session_id),
  -- Delete arms when session removed
  CONSTRAINT recorded_session_arms_session_fk
    FOREIGN KEY (recorded_session_id) REFERENCES recorded_sessions(id) ON DELETE CASCADE
);
