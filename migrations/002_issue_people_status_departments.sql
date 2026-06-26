ALTER TABLE issues ADD COLUMN poster_name TEXT NOT NULL DEFAULT '';
ALTER TABLE issues ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';

CREATE TABLE IF NOT EXISTS issue_departments (
  issue_id INTEGER NOT NULL,
  department_id INTEGER NOT NULL,
  PRIMARY KEY (issue_id, department_id),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE RESTRICT
);

INSERT OR IGNORE INTO issue_departments (issue_id, department_id)
SELECT id, department_id
FROM issues
WHERE department_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_issue_departments_department_id ON issue_departments(department_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_poster_name ON issues(poster_name);
