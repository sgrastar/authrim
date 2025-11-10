# GitHub Setup Guide for Hibana

This guide explains how to set up GitHub issues, labels, milestones, and project boards for the Hibana project.

---

## Quick Setup (Automated)

### Prerequisites
1. Install GitHub CLI: https://cli.github.com/
2. Authenticate: `gh auth login`

### Run Setup Scripts

```bash
# 1. Create labels, milestones, and project
./scripts/setup-github.sh

# 2. Create Phase 1 issues (Week 1-5 tasks)
./scripts/create-phase1-issues.sh
```

That's it! Your GitHub repository is now fully configured.

---

## What Gets Created

### Labels

**Phase Labels** (for organizing by project phase):
- `phase:1-foundation` - Phase 1 tasks (green)
- `phase:2-core` - Phase 2 tasks (blue)
- `phase:3-testing` - Phase 3 tasks (yellow)
- `phase:4-extended` - Phase 4 tasks (orange)
- `phase:5-certification` - Phase 5 tasks (light blue)

**Type Labels** (for categorizing work):
- `type:feature` - New features or endpoints
- `type:bug` - Bug reports
- `type:task` - General tasks/chores
- `type:docs` - Documentation
- `type:test` - Testing related
- `type:refactor` - Code refactoring

**Priority Labels**:
- `priority:high` - High priority (red)
- `priority:medium` - Medium priority (yellow)
- `priority:low` - Low priority (green)

**Status Labels**:
- `status:blocked` - Blocked by another issue
- `status:in-review` - In code review
- `status:ready` - Ready to work on

**Component Labels** (for identifying which part of the system):
- `component:auth` - Authorization/authentication
- `component:token` - Token generation/validation
- `component:discovery` - Discovery endpoint
- `component:jwks` - JWKS endpoint
- `component:userinfo` - UserInfo endpoint
- `component:kv` - KV storage
- `component:security` - Security related

### Milestones

Five milestones matching the project schedule:

| Milestone | Due Date | Description |
|:----------|:---------|:------------|
| **M1: Foundation Complete** | Dec 15, 2025 | Development environment and project structure |
| **M2: OIDC Core Complete** | Jan 31, 2026 | All core OpenID Connect endpoints implemented |
| **M3: Conformance Suite Passing** | Mar 15, 2026 | Pass OpenID Conformance Suite tests (≥85%) |
| **M4: Extended Features Complete** | Apr 30, 2026 | Dynamic Registration, key rotation, security audit |
| **M5: OpenID Certified** | May 31, 2026 | Production deployment and certification obtained |

### Issue Templates

Three issue templates are available when creating new issues:

1. **Feature Implementation** (`.github/ISSUE_TEMPLATE/feature.yml`)
   - For new features or endpoints
   - Includes phase, priority, acceptance criteria

2. **Bug Report** (`.github/ISSUE_TEMPLATE/bug.yml`)
   - For reporting bugs
   - Includes severity, steps to reproduce, expected/actual behavior

3. **Task / Chore** (`.github/ISSUE_TEMPLATE/task.yml`)
   - For documentation, refactoring, setup tasks
   - Includes category, phase, checklist

### Phase 1 Issues

The `create-phase1-issues.sh` script creates 5 major issues for Phase 1:

- **Week 1**: Project Structure & Environment Setup
- **Week 2**: Hono Framework Integration
- **Week 3**: Cloudflare Services Integration
- **Week 4**: Authentication & Testing Framework
- **Week 5**: CI/CD & Documentation

Each issue includes:
- Detailed task checklist
- Timeline
- Acceptance criteria
- Links to relevant documentation

---

## Manual Setup (Alternative)

If you prefer to set up manually or the scripts don't work:

### Create Labels

Go to `https://github.com/your-username/hibana/labels` and create labels according to the color scheme above.

### Create Milestones

Go to `https://github.com/your-username/hibana/milestones` and create the 5 milestones with their due dates.

### Create Issues

Use the issue templates to create issues, or create them manually following the format in `create-phase1-issues.sh`.

### Create Project Board

1. Go to your repository's "Projects" tab
2. Click "New Project"
3. Choose "Board" layout
4. Name it "Hibana Development"
5. Add columns:
   - **Backlog** - Issues not yet started
   - **Ready** - Issues ready to work on
   - **In Progress** - Currently being worked on
   - **In Review** - In code review
   - **Done** - Completed issues

6. Link issues to the project board

---

## Using the GitHub Workflow

### Creating New Issues

```bash
# Create a new feature issue
gh issue create \
  --title "Implement /authorize endpoint" \
  --label "phase:2-core,type:feature,priority:high,component:auth" \
  --milestone "M2: OIDC Core Complete" \
  --body "Description of the feature..."

# Create a bug report
gh issue create \
  --title "JWT signature verification fails" \
  --label "type:bug,priority:high,component:token" \
  --body "Bug description..."
```

### Viewing Issues

```bash
# List all open issues
gh issue list

# List issues for a specific milestone
gh issue list --milestone "M1: Foundation Complete"

# List issues by label
gh issue list --label "phase:1-foundation"

# List high priority issues
gh issue list --label "priority:high"
```

### Working on Issues

```bash
# View issue details
gh issue view 123

# Assign yourself to an issue
gh issue edit 123 --add-assignee @me

# Add labels
gh issue edit 123 --add-label "status:in-review"

# Close an issue
gh issue close 123 --comment "Completed in PR #456"
```

### Linking Issues to Pull Requests

In your PR description or commits, use keywords:
- `Closes #123` - Automatically closes issue when PR is merged
- `Fixes #123` - Same as above
- `Resolves #123` - Same as above
- `Related to #123` - Links but doesn't auto-close

Example:
```markdown
## Description
This PR implements the /authorize endpoint.

Closes #123
Related to #124
```

---

## Project Board Workflow

### Recommended Flow

1. **Backlog** → New issues start here
2. **Ready** → Issues that are ready to work on (dependencies met)
3. **In Progress** → Move here when you start working (max 1-2 issues per person)
4. **In Review** → Move here when PR is created
5. **Done** → Auto-moved when issue is closed

### Automation Ideas

- Auto-add new issues to Backlog
- Auto-move to "In Progress" when PR is created
- Auto-move to "Done" when issue is closed
- Auto-label based on milestone

---

## Best Practices

### Issue Naming
- Use clear, descriptive titles
- Start with action verb: "Implement", "Fix", "Add", "Update"
- Include component: "Implement /authorize endpoint"

### Labels
- Always add phase label
- Always add type label
- Add priority label
- Add component label when applicable

### Milestones
- Assign issues to appropriate milestone
- Track milestone progress regularly
- Adjust deadlines if needed

### Task Lists
- Use GitHub task lists in issue descriptions: `- [ ] Task`
- Check off tasks as completed
- Update issue status when all tasks done

### Documentation
- Link to relevant docs in issues
- Reference specification sections when applicable
- Add code examples for clarity

---

## Tracking Progress

### Weekly Review Checklist

```bash
# Check milestone progress
gh issue list --milestone "M1: Foundation Complete" --json number,title,state

# Check what's in progress
gh issue list --label "status:in-progress"

# Check blocked issues
gh issue list --label "status:blocked"

# Check this week's completed issues
gh issue list --search "closed:>=$(date -d '7 days ago' +%Y-%m-%d)" --state closed
```

### Generate Progress Report

```bash
# Count issues by status
echo "Open: $(gh issue list --json state | jq '[.[] | select(.state=="OPEN")] | length')"
echo "Closed: $(gh issue list --state closed --json state | jq 'length')"

# Issues per milestone
for m in "M1" "M2" "M3" "M4" "M5"; do
  count=$(gh issue list --milestone "$m: *" --json number | jq 'length')
  echo "$m: $count issues"
done
```

---

## Troubleshooting

### Script Fails: "gh: command not found"
**Solution**: Install GitHub CLI from https://cli.github.com/

### Script Fails: "Not authenticated"
**Solution**: Run `gh auth login` and follow the prompts

### Script Fails: "API rate limit exceeded"
**Solution**: Wait an hour or use a GitHub token with higher rate limits

### Labels/Milestones Already Exist
**Solution**: Scripts use `--force` flag, but if you get errors, delete existing labels/milestones first

### Permission Denied
**Solution**: Ensure you have write access to the repository

---

## Advanced: Integrating with CI/CD

Add automatic labeling in `.github/workflows/`:

```yaml
name: Auto Label
on:
  pull_request:
    types: [opened, edited]

jobs:
  label:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/labeler@v4
        with:
          repo-token: ${{ secrets.GITHUB_TOKEN }}
```

---

## Resources

- [GitHub Issues Documentation](https://docs.github.com/en/issues)
- [GitHub CLI Manual](https://cli.github.com/manual/)
- [GitHub Projects Guide](https://docs.github.com/en/issues/planning-and-tracking-with-projects)
- [Linking PRs to Issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue)

---

> **Hibana** 🔥 — Organized development through structured issue tracking.
