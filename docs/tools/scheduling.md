# Scheduling Tools

jellyclaw provides tools for scheduling future agent actions. These tools allow an agent to set reminders, schedule periodic tasks, and create recurring jobs.

## Prerequisites

All scheduling tools require the scheduler daemon to be running:

```bash
jellyclaw daemon start
```

See [daemon.md](../daemon.md) for daemon installation and management.

## Tools

### ScheduleWakeup

Schedule a one-shot delayed resume. The prompt executes after the specified delay.

**Input:**
- `delaySeconds` (integer, 60-3600): Delay before firing
- `prompt` (string, 1-8192 chars): The prompt to execute
- `reason` (string, 1-512 chars): Human-readable reason

**Output:**
- `job_id` (string): Unique job identifier
- `fire_at_unix_ms` (number): Unix timestamp when job will fire

**Example:**
```json
{
  "delaySeconds": 300,
  "prompt": "Check if the build completed successfully",
  "reason": "Waiting for CI pipeline"
}
```

### CronCreate

Create a recurring cron job. The prompt executes on the specified schedule.

**Input:**
- `expression` (string): 5-field cron expression (minute hour day-of-month month day-of-week)
- `prompt` (string, 1-8192 chars): The prompt to execute on each fire
- `reason` (string, 1-512 chars): Human-readable reason

**Output:**
- `job_id` (string): Unique job identifier
- `next_fire_at_unix_ms` (number): Unix timestamp of next fire

**Example:**
```json
{
  "expression": "0 9 * * 1-5",
  "prompt": "Generate daily standup summary from yesterday's commits",
  "reason": "Morning standup automation"
}
```

**Cron Expression Examples:**
| Expression | Description |
|------------|-------------|
| `*/5 * * * *` | Every 5 minutes |
| `0 * * * *` | Every hour at minute 0 |
| `0 9 * * *` | Daily at 9:00 AM |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `0 0 1 * *` | First day of each month at midnight |
| `30 4 * * 0` | Sundays at 4:30 AM |

### CronList

List all cron jobs owned by the current session.

**Input:** (none)

**Output:** Array of job objects:
- `id` (string): Job identifier
- `expression` (string): Cron expression
- `prompt` (string): The prompt
- `reason` (string): The reason
- `next_fire_at_unix_ms` (number): Next fire time
- `fire_count` (number): Times this job has fired
- `last_fired_at_unix_ms` (number | null): Last fire time
- `status` (string): Job status (pending, running, done, failed, cancelled)

### CronDelete

Delete a cron job by ID. Only jobs owned by the current session can be deleted.

**Input:**
- `id` (string): Job ID to delete

**Output:**
- `deleted` (boolean): Whether the job was successfully deleted

## Session Ownership

Jobs are scoped to the session that created them:
- `CronList` only returns jobs owned by the current session
- `CronDelete` can only delete jobs owned by the current session
- When a job fires, it resumes in the context of its owning session

## Error Handling

All scheduling tools can return these errors:

| Error Code | Description |
|------------|-------------|
| `daemon_unreachable` | Scheduler daemon is not running |
| `invalid_expression` | Invalid cron expression (CronCreate only) |
| `unknown_job` | Job ID not found (CronDelete only) |
| `forbidden` | Cannot delete job owned by another session |
| `schedule_failed` | Generic scheduling failure |

## Budget Limits

The daemon respects daily budget caps (when implemented). If the budget is exceeded:
- Wakeup jobs are marked failed and not executed
- Cron jobs are rescheduled to the next fire time and skip the current execution

## Persistence

All scheduled jobs are persisted to SQLite (`~/.jellyclaw/scheduler.db`). Jobs survive:
- Agent session restarts
- Daemon restarts
- System reboots (if using launchd/systemd service)

## Best Practices

1. **Use meaningful reasons**: The `reason` field helps identify jobs in logs and listings
2. **Prefer cron for recurring tasks**: One cron job is better than chaining wakeups
3. **Handle daemon unavailability**: Catch `daemon_unreachable` and inform the user
4. **Clean up old jobs**: Use CronDelete to remove jobs that are no longer needed
5. **Use appropriate delays**: Minimum 60s, maximum 3600s for wakeups
