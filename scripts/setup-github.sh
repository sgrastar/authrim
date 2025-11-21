#!/bin/bash
# Setup GitHub labels, milestones, and project for Authrim

set -e

echo "🔥 Setting up GitHub repository for Authrim..."
echo ""

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    echo "❌ Error: GitHub CLI (gh) is not installed"
    echo "Install it from: https://cli.github.com/"
    exit 1
fi

# Check if authenticated
if ! gh auth status &> /dev/null; then
    echo "❌ Error: Not authenticated with GitHub"
    echo "Run: gh auth login"
    exit 1
fi

echo "✅ GitHub CLI is installed and authenticated"
echo ""

# =============================================================================
# CREATE LABELS
# =============================================================================

echo "📝 Creating labels..."

# Phase labels
gh label create "phase:1-foundation" --description "Phase 1: Foundation tasks" --color "0E8A16" --force
gh label create "phase:2-core" --description "Phase 2: Core Implementation tasks" --color "1D76DB" --force
gh label create "phase:3-testing" --description "Phase 3: Testing & Validation tasks" --color "FBCA04" --force
gh label create "phase:4-extended" --description "Phase 4: Extended Features tasks" --color "D93F0B" --force
gh label create "phase:5-certification" --description "Phase 5: Certification Prep tasks" --color "C5DEF5" --force

# Type labels
gh label create "type:feature" --description "New feature or endpoint" --color "0075ca" --force
gh label create "type:bug" --description "Something isn't working" --color "d73a4a" --force
gh label create "type:task" --description "General task or chore" --color "7057ff" --force
gh label create "type:docs" --description "Documentation improvements" --color "0075ca" --force
gh label create "type:test" --description "Testing related" --color "00ff00" --force
gh label create "type:refactor" --description "Code refactoring" --color "fbca04" --force

# Priority labels
gh label create "priority:high" --description "High priority" --color "d93f0b" --force
gh label create "priority:medium" --description "Medium priority" --color "fbca04" --force
gh label create "priority:low" --description "Low priority" --color "0e8a16" --force

# Status labels
gh label create "status:blocked" --description "Blocked by another issue" --color "d73a4a" --force
gh label create "status:in-review" --description "In code review" --color "fbca04" --force
gh label create "status:ready" --description "Ready to work on" --color "0e8a16" --force

# Component labels
gh label create "component:auth" --description "Authorization/authentication" --color "c5def5" --force
gh label create "component:token" --description "Token generation/validation" --color "c5def5" --force
gh label create "component:discovery" --description "Discovery endpoint" --color "c5def5" --force
gh label create "component:jwks" --description "JWKS endpoint" --color "c5def5" --force
gh label create "component:userinfo" --description "UserInfo endpoint" --color "c5def5" --force
gh label create "component:kv" --description "KV storage" --color "c5def5" --force
gh label create "component:security" --description "Security related" --color "d73a4a" --force

echo "✅ Labels created"
echo ""

# =============================================================================
# CREATE MILESTONES
# =============================================================================

echo "🎯 Creating milestones..."

gh api repos/:owner/:repo/milestones -X POST -f title="M1: Foundation Complete" -f due_on="2025-12-15T23:59:59Z" -f description="Establish development environment and project structure. Complete TypeScript setup, Cloudflare Workers environment, Hono integration, and basic CI/CD." || echo "Milestone M1 may already exist"

gh api repos/:owner/:repo/milestones -X POST -f title="M2: OIDC Core Complete" -f due_on="2026-01-31T23:59:59Z" -f description="Implement all core OpenID Connect endpoints: discovery, JWKS, authorize, token, and userinfo. Complete JWT signing and KV-based state management." || echo "Milestone M2 may already exist"

gh api repos/:owner/:repo/milestones -X POST -f title="M3: Conformance Suite Passing" -f due_on="2026-03-15T23:59:59Z" -f description="Pass OpenID Foundation Conformance Suite tests for Basic OP Profile. Achieve conformance score ≥85%." || echo "Milestone M3 may already exist"

gh api repos/:owner/:repo/milestones -X POST -f title="M4: Extended Features Complete" -f due_on="2026-04-30T23:59:59Z" -f description="Implement Dynamic Client Registration, JWKS key rotation, extended claims, and complete security audit." || echo "Milestone M4 may already exist"

gh api repos/:owner/:repo/milestones -X POST -f title="M5: OpenID Certified" -f due_on="2026-05-31T23:59:59Z" -f description="Deploy to production and obtain OpenID Certified™ Basic OP Profile certification." || echo "Milestone M5 may already exist"

echo "✅ Milestones created"
echo ""

# =============================================================================
# CREATE GITHUB PROJECT
# =============================================================================

echo "📊 Creating GitHub Project..."

# Create project (Projects v2)
PROJECT_ID=$(gh api graphql -f query='
  mutation {
    createProjectV2(input: {
      ownerId: "MDQ6VXNlcjEyMzQ1Njc4OQ=="
      title: "Authrim Development"
      repositoryId: "R_kgDOLxYzXw"
    }) {
      projectV2 {
        id
        number
      }
    }
  }
' --jq '.data.createProjectV2.projectV2.id' 2>/dev/null || echo "")

if [ -n "$PROJECT_ID" ]; then
    echo "✅ GitHub Project created"
else
    echo "⚠️  Could not create GitHub Project (may need to be done manually via UI)"
fi

echo ""

# =============================================================================
# SUMMARY
# =============================================================================

echo "🎉 GitHub setup complete!"
echo ""
echo "Next steps:"
echo "1. Visit your repository's Issues tab to see the new labels"
echo "2. Visit the Milestones tab to see M1-M5"
echo "3. Create issues using the new templates"
echo "4. Optionally create a GitHub Project board via the UI"
echo ""
echo "To create your first issue:"
echo "  gh issue create --title \"Setup project structure\" --label \"phase:1-foundation,type:task,priority:high\" --milestone \"M1: Foundation Complete\""
echo ""
