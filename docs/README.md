# Hibana Documentation

Complete documentation for the Hibana OpenID Connect Provider project.

> **Quick Navigation**: Use the search function (Ctrl+F / Cmd+F) or jump to:
> [Project Management](#-project-management) | [Architecture](#️-architecture--specifications) | [Conformance Testing](#-conformance-testing) | [Finding Information](#-finding-information)

---

## 📋 Project Management

Documents for planning, scheduling, and tracking project progress.

| Document | Description |
|:---------|:------------|
| [Project Schedule](./project-management/SCHEDULE.md) | 6-month timeline with 5 major milestones (M1-M5) |
| [Task Breakdown](./project-management/TASKS.md) | Detailed week-by-week task checklist (440+ tasks) |
| [Kickoff Checklist](./project-management/KICKOFF.md) | Week 1 immediate action items and setup guide |
| [GitHub Workflow](./project-management/GITHUB_WORKFLOW.md) | Issue tracking, labels, milestones, and project board setup |

**Quick Start**: Begin with the [Kickoff Checklist](./project-management/KICKOFF.md) for Week 1 tasks.

---

## 🏗️ Architecture & Specifications

Technical specifications and protocol flow documentation.

| Document | Description |
|:---------|:------------|
| [Protocol Flow](./architecture/protocol-flow.md) | End-to-end OIDC Authorization Code Flow specification |
| [Technical Specs](./architecture/technical-specs.md) | System architecture, components, and endpoint specifications |

**For AI/LLM Analysis**: These documents are structured for machine-readable analysis of Hibana's behavior and compliance.

---

## ✅ Conformance Testing

OpenID Connect conformance testing strategy and test plans.

| Document | Description |
|:---------|:------------|
| [Conformance Overview](./conformance/overview.md) | High-level conformance strategy and certification roadmap |
| [Test Plan](./conformance/test-plan.md) | Detailed test mapping and conformance requirements |

**Target**: Achieve OpenID Certified™ Basic OP Profile by May 31, 2026.

---

## 📖 Document Categories

### For Project Managers
- [Project Schedule](./project-management/SCHEDULE.md) - Timeline and milestones
- [GitHub Workflow](./project-management/GITHUB_WORKFLOW.md) - Issue tracking system

### For Developers
- [Kickoff Checklist](./project-management/KICKOFF.md) - Setup and getting started
- [Task Breakdown](./project-management/TASKS.md) - Detailed implementation tasks
- [Technical Specs](./architecture/technical-specs.md) - Architecture overview

### For Implementers
- [Protocol Flow](./architecture/protocol-flow.md) - OIDC flow step-by-step
- [Test Plan](./conformance/test-plan.md) - Testing requirements

### For Certification
- [Conformance Overview](./conformance/overview.md) - Certification strategy
- [Test Plan](./conformance/test-plan.md) - Conformance test mapping

---

## 🔄 Document Status

| Phase | Status | Documentation |
|:------|:-------|:--------------|
| **Phase 1: Foundation** | 📝 Planning Complete | All Week 1-5 tasks documented |
| **Phase 2: Core** | 📝 Planning Complete | All Week 6-12 tasks documented |
| **Phase 3: Testing** | 📝 Planning Complete | Conformance test plan ready |
| **Phase 4: Extended** | 📝 Planning Complete | Extension features planned |
| **Phase 5: Certification** | 📝 Planning Complete | Certification path defined |

---

## 📅 Project Timeline Summary

```
Phase 1: Foundation          [Nov 10 - Dec 15, 2025]  ✅ Planned
Phase 2: Core Implementation [Dec 16 - Jan 31, 2026]  ✅ Planned
Phase 3: Testing & Validation [Feb 1 - Mar 15, 2026]   ✅ Planned
Phase 4: Extended Features   [Mar 16 - Apr 30, 2026]  ✅ Planned
Phase 5: Certification Prep  [May 1 - May 31, 2026]   ✅ Planned
```

**Total Duration**: 6 months
**Target Certification Date**: May 31, 2026

---

## 🎯 Key Milestones

| # | Milestone | Date | Status |
|:--|:----------|:-----|:-------|
| M1 | Foundation Complete | Dec 15, 2025 | ⏳ Pending |
| M2 | OIDC Core Complete | Jan 31, 2026 | ⏳ Pending |
| M3 | Conformance Suite Passing | Mar 15, 2026 | ⏳ Pending |
| M4 | Extended Features Complete | Apr 30, 2026 | ⏳ Pending |
| M5 | OpenID Certified™ | May 31, 2026 | ⏳ Pending |

---

## 🔍 Finding Information

### "How do I get started?"
→ [Kickoff Checklist](./project-management/KICKOFF.md)

### "What's the project timeline?"
→ [Project Schedule](./project-management/SCHEDULE.md)

### "What tasks do I need to complete?"
→ [Task Breakdown](./project-management/TASKS.md)

### "How do I track issues?"
→ [GitHub Workflow](./project-management/GITHUB_WORKFLOW.md)

### "How does OIDC work in Hibana?"
→ [Protocol Flow](./architecture/protocol-flow.md)

### "What are the technical requirements?"
→ [Technical Specs](./architecture/technical-specs.md)

### "How do we achieve certification?"
→ [Conformance Overview](./conformance/overview.md)

### "What tests do we need to pass?"
→ [Test Plan](./conformance/test-plan.md)

---

## 📝 Contributing to Documentation

When adding or updating documentation:

1. **Follow the structure**: Place documents in the appropriate category folder
2. **Use clear titles**: Make document purpose obvious from the filename
3. **Link appropriately**: Update this index when adding new documents
4. **Keep it current**: Update status and dates as project progresses
5. **Be consistent**: Follow existing formatting and style
6. **Add cross-references**: Link to related documents at the beginning of each file
7. **Use examples**: Include `id.example.dev` for examples, `id.hibana.dev` for production references

### Documentation Quality Standards

- All markdown files must be properly formatted
- Code blocks must use correct syntax highlighting
- All internal links must be tested and working
- Documents should be understandable without reading others (but with helpful cross-references)

---

## 📚 External Resources

### OpenID Connect Specifications
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html)
- [Dynamic Client Registration 1.0](https://openid.net/specs/openid-connect-registration-1_0.html)

### OAuth 2.0 Specifications
- [RFC 6749 - OAuth 2.0 Framework](https://datatracker.ietf.org/doc/html/rfc6749)
- [RFC 6750 - Bearer Token Usage](https://datatracker.ietf.org/doc/html/rfc6750)

### JWT/JWK Specifications
- [RFC 7519 - JSON Web Token (JWT)](https://datatracker.ietf.org/doc/html/rfc7519)
- [RFC 7517 - JSON Web Key (JWK)](https://datatracker.ietf.org/doc/html/rfc7517)

### Conformance Testing
- [OpenID Certification](https://openid.net/certification/)
- [Conformance Test Suite](https://openid.net/certification/testing/)

### Technology Stack
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Hono Framework](https://hono.dev/)
- [JOSE Library](https://github.com/panva/jose)

---

> **Hibana** 🔥 — Comprehensive documentation for edge-native OpenID Connect.
