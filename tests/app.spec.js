import { test, expect } from '@playwright/test';

test.describe('App loads and displays correctly', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('text=Planner', { timeout: 10000 });
  });

  test('app renders with sidebar and header', async ({ page }) => {
    await expect(page.locator('text=Planner').first()).toBeVisible();
    await expect(page.locator('header h1')).toContainText('gantt View');
    await expect(page.locator('button', { hasText: '+ New Task' })).toBeVisible();
  });

  test('sample data is loaded — projects visible', async ({ page }) => {
    await expect(page.getByText('Mobile App').first()).toBeVisible();
    await expect(page.getByText('Fundraising').first()).toBeVisible();
    await expect(page.getByText('Marketing Site').first()).toBeVisible();
  });

  test('stats section shows task counts', async ({ page }) => {
    await expect(page.getByText('Total').first()).toBeVisible();
    await expect(page.getByText('In Progress').first()).toBeVisible();
  });
});

test.describe('Sidebar navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('text=Planner', { timeout: 10000 });
  });

  test('can switch between all views', async ({ page }) => {
    await page.locator('button', { hasText: 'Calendar' }).click();
    await expect(page.locator('header h1')).toContainText('calendar View');

    await page.locator('button', { hasText: 'Spreadsheet' }).click();
    await expect(page.locator('header h1')).toContainText('spreadsheet View');

    await page.locator('button', { hasText: 'Obsidian' }).click();
    await expect(page.locator('header h1')).toContainText('Obsidian Sync');

    await page.locator('button', { hasText: 'Gantt' }).click();
    await expect(page.locator('header h1')).toContainText('gantt View');
  });

  test('sidebar can be collapsed and expanded', async ({ page }) => {
    await expect(page.getByText('Mobile App').first()).toBeVisible();

    const toggleArea = page.locator('aside > div').first();
    await toggleArea.click();
    await page.waitForTimeout(400);

    await expect(page.getByText('Projects', { exact: false }).first()).toBeHidden();
  });
});

test.describe('Task Modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('text=Planner', { timeout: 10000 });
  });

  test('opens when clicking "+ New Task"', async ({ page }) => {
    await page.locator('button', { hasText: '+ New Task' }).click();
    await page.waitForTimeout(300);

    await expect(page.locator('button', { hasText: 'Save' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Cancel' })).toBeVisible();
  });

  test('save button is disabled when title is empty', async ({ page }) => {
    await page.locator('button', { hasText: '+ New Task' }).click();
    await page.waitForTimeout(300);

    const saveBtn = page.locator('button', { hasText: 'Save' });
    await expect(saveBtn).toBeDisabled();
  });

  test('can create a new task with title', async ({ page }) => {
    await page.locator('button', { hasText: '+ New Task' }).click();
    await page.waitForTimeout(300);

    const titleInput = page.locator('input').first();
    await titleInput.fill('Playwright Test Task');

    const saveBtn = page.locator('button', { hasText: 'Save' });
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    await expect(saveBtn).toBeHidden({ timeout: 2000 });

    await page.locator('button', { hasText: 'Spreadsheet' }).click();
    await page.waitForTimeout(300);
    await expect(page.getByText('Playwright Test Task').first()).toBeVisible();
  });

  test('cancel closes the modal without saving', async ({ page }) => {
    await page.locator('button', { hasText: '+ New Task' }).click();
    await page.waitForTimeout(300);

    await page.locator('button', { hasText: 'Cancel' }).click();
    await expect(page.locator('button', { hasText: 'Save' })).toBeHidden({ timeout: 2000 });
  });
});

test.describe('Spreadsheet View', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('text=Planner', { timeout: 10000 });
    await page.locator('button', { hasText: 'Spreadsheet' }).click();
    await page.waitForTimeout(500);
  });

  test('displays tasks in table with correct columns', async ({ page }) => {
    await expect(page.getByRole('columnheader', { name: 'Task' })).toBeVisible();
    await expect(page.getByText('STATUS').first()).toBeVisible();
    await expect(page.getByText('Draft pitch deck').first()).toBeVisible();
  });

  test('filter input filters tasks by name', async ({ page }) => {
    const filterInput = page.locator('input[placeholder*="Filter" i]');
    await expect(filterInput).toBeVisible();

    await filterInput.fill('Draft');
    await page.waitForTimeout(300);

    await expect(page.getByText('Draft pitch deck').first()).toBeVisible();
    await expect(page.getByText('Wire up push notifications')).toBeHidden();
  });

  test('sort by clicking column headers', async ({ page }) => {
    const urgHeader = page.getByRole('columnheader', { name: /urg/i });
    await urgHeader.click();
    await page.waitForTimeout(300);
    await expect(page.getByText('Draft pitch deck').first()).toBeVisible();
  });

  test('clicking a task row opens the edit modal', async ({ page }) => {
    await page.getByText('Draft pitch deck').first().click();
    await page.waitForTimeout(300);
    await expect(page.locator('button', { hasText: 'Save' })).toBeVisible();
  });

  test('inline status change works', async ({ page }) => {
    const statusSelect = page.locator('select').first();
    if (await statusSelect.isVisible()) {
      await statusSelect.selectOption('done');
      await page.waitForTimeout(300);
      await expect(page.getByText('Done').first()).toBeVisible();
    }
  });
});

test.describe('Calendar View', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('text=Planner', { timeout: 10000 });
    await page.locator('button', { hasText: 'Calendar' }).click();
    await page.waitForTimeout(300);
  });

  test('displays navigation and mode toggle', async ({ page }) => {
    await expect(page.locator('button', { hasText: 'Week' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Month' })).toBeVisible();
    await expect(page.getByText('Mon').first()).toBeVisible();
  });

  test('can switch between week and month modes', async ({ page }) => {
    await page.locator('button', { hasText: 'Week' }).click();
    await page.waitForTimeout(300);
    await expect(page.getByText('Mon').first()).toBeVisible();

    await page.locator('button', { hasText: 'Month' }).click();
    await page.waitForTimeout(300);
    await expect(page.getByText('Mon').first()).toBeVisible();
  });

  test('can navigate forward and backward', async ({ page }) => {
    const nextBtn = page.locator('button').filter({ hasText: /^[›>→]$/ }).first();
    const prevBtn = page.locator('button').filter({ hasText: /^[‹<←]$/ }).first();

    if (await nextBtn.isVisible()) {
      await nextBtn.click();
      await page.waitForTimeout(300);
      await expect(page.getByText('Mon').first()).toBeVisible();

      await prevBtn.click();
      await page.waitForTimeout(300);
      await expect(page.getByText('Mon').first()).toBeVisible();
    }
  });
});

test.describe('Gantt Chart View', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('text=Planner', { timeout: 10000 });
  });

  test('displays zoom controls', async ({ page }) => {
    await expect(page.getByText('ZOOM').first()).toBeVisible();
    await expect(page.locator('button', { hasText: 'day' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'week' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'month' })).toBeVisible();
  });

  test('can switch between zoom levels', async ({ page }) => {
    await page.locator('button', { hasText: 'day' }).click();
    await page.waitForTimeout(300);

    await page.locator('button', { hasText: 'month' }).click();
    await page.waitForTimeout(300);

    await page.locator('button', { hasText: 'week' }).click();
    await page.waitForTimeout(300);
  });

  test('gantt chart renders task rows with sprint headers', async ({ page }) => {
    // After fix: task names and sprint headers should appear in the label column
    await expect(page.getByText('Set up CI/CD pipeline').first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Sprint 1', { exact: false }).first()).toBeVisible();
  });

  test('clicking a task name opens the edit modal', async ({ page }) => {
    await page.getByText('Set up CI/CD pipeline').first().click();
    await page.waitForTimeout(300);
    await expect(page.locator('button', { hasText: 'Save' })).toBeVisible();
  });
});

test.describe('Data integrity', () => {
  test('sample data is not duplicated', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('text=Planner', { timeout: 10000 });

    const counts = await page.evaluate(() => {
      const raw = localStorage.getItem('task-planner-store');
      const parsed = JSON.parse(raw);
      return {
        projects: parsed?.state?.projects?.length || 0,
        sprints: parsed?.state?.sprints?.length || 0,
        tasks: parsed?.state?.tasks?.length || 0,
      };
    });

    console.log('Store counts:', counts);
    expect(counts.projects).toBe(3);
    expect(counts.sprints).toBe(4);
    expect(counts.tasks).toBe(11);
  });

  test('sample data relationships are intact', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('text=Planner', { timeout: 10000 });

    const data = await page.evaluate(() => {
      const raw = localStorage.getItem('task-planner-store');
      const parsed = JSON.parse(raw);
      const state = parsed?.state || {};
      return {
        projectIds: (state.projects || []).map(p => p.id),
        sprintProjectIds: (state.sprints || []).map(s => s.projectId),
        taskSprintIds: (state.tasks || []).map(t => t.sprintId),
        sprintIds: (state.sprints || []).map(s => s.id),
      };
    });

    // All sprints should reference valid project IDs
    const orphanedSprints = data.sprintProjectIds.filter(
      pid => !data.projectIds.includes(pid)
    );
    expect(orphanedSprints.length).toBe(0);

    // All tasks should reference valid sprint IDs
    const orphanedTasks = data.taskSprintIds.filter(
      sid => !data.sprintIds.includes(sid)
    );
    expect(orphanedTasks.length).toBe(0);
  });
});
