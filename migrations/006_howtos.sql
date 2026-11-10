CREATE TABLE IF NOT EXISTS howtos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  intro_html TEXT NOT NULL DEFAULT '',
  needs_update INTEGER NOT NULL DEFAULT 0,
  search_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS howto_departments (
  howto_id INTEGER NOT NULL,
  department_id INTEGER NOT NULL,
  PRIMARY KEY (howto_id, department_id),
  FOREIGN KEY (howto_id) REFERENCES howtos(id) ON DELETE CASCADE,
  FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS howto_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  howto_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  heading TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (howto_id) REFERENCES howtos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS howto_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  filename TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  uploaded_at TEXT NOT NULL,
  FOREIGN KEY (step_id) REFERENCES howto_steps(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_howto_departments_department_id ON howto_departments(department_id);
CREATE INDEX IF NOT EXISTS idx_howto_steps_howto_id ON howto_steps(howto_id, position);
CREATE INDEX IF NOT EXISTS idx_howto_images_step_id ON howto_images(step_id, position);
CREATE INDEX IF NOT EXISTS idx_howtos_updated_at ON howtos(updated_at);
