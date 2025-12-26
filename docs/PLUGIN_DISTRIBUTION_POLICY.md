# Authrim Plugin Distribution and Responsibility Policy

## Overview

This document defines the distribution methods, responsibility boundaries, and compatibility policies for Authrim plugins.

---

## 1. Responsibility Model

### Authrim's Responsibilities

1. **Platform Stability**
   - No breaking changes within major versions (e.g., 1.x.x)
   - Maintain backward compatibility of the Plugin API

2. **Response When Breaking Changes Occur**
   - Contact affected plugin authors
   - Release fixes or update documentation

3. **Information Provision**
   - Display compatibility warnings
   - Display plugin source (loading origin)

### Plugin Author's Responsibilities

1. **Security**
   - Provide vulnerability-free code
   - Manage dependencies

2. **Compatibility**
   - Accurate declaration of `minAuthrimVersion` / `maxAuthrimVersion`
   - Verify functionality when Authrim versions are upgraded

3. **Maintenance**
   - Bug fixes
   - User support

### Disclaimer

```
Third-party plugins are provided by their respective authors.
Authrim does not guarantee the security, reliability, or
compatibility of third-party plugins. Use at your own risk.
```

---

## 2. Plugin Distribution Methods

### Recommended Distribution Methods

| Method | Target | Characteristics |
|--------|--------|-----------------|
| **npm package** | Public plugins | Easy version management and dependency resolution |
| **Monorepo built-in** | Official plugins | Released simultaneously with Authrim |
| **Private npm** | Enterprise plugins | Utilizes npm mechanisms while remaining private |
| **Local files** | Development/testing | Most flexible |

### Recommended npm Package Structure

```json
{
  "name": "@your-org/authrim-plugin-xxx",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "peerDependencies": {
    "@authrim/ar-lib-plugin": "^1.0.0"
  },
  "keywords": ["authrim", "authrim-plugin"]
}
```

---

## 3. Official Plugin Determination

### Criteria

| Condition | Determination | UI Display |
|-----------|---------------|------------|
| Built into `ar-lib-plugin/src/builtin/` | Official | ⭐ Authrim Official (Built-in) |
| npm `@authrim/*` scope | Official | ⭐ Authrim Official (npm) |
| Other | Community | 🧩 Community Plugin |

### Important Notes

- The `official: true` flag is **UI supplementary information** and is not a basis for trust
- `author.name: 'Authrim'` is **self-declared** and not verified
- Official status is determined **only by distribution channel (source)**

---

## 4. Compatibility Policy

### Authrim Versioning Convention

```
Major.Minor.Patch (e.g., 1.5.2)
   │       │      └── Bug fixes (maintains compatibility)
   │       └────────── Feature additions (maintains compatibility)
   └────────────────── Breaking changes
```

### Plugin Compatibility Declaration

```typescript
meta: {
  // Minimum supported version (recommended as required)
  minAuthrimVersion: '1.0.0',

  // Maximum supported version (optional)
  // Set when major version increases
  maxAuthrimVersion: '1.999.999',
}
```

### Compatibility Check at Startup

| State | Level | Behavior |
|-------|-------|----------|
| Older than `minAuthrimVersion` | ⚠️ warn | Log output, continue operation |
| Newer than `maxAuthrimVersion` | ⚠️ warn | Log output, continue operation |
| `stability: 'deprecated'` | ⚠️ warn | Deprecation warning |
| `stability: 'alpha'` in production | ⚠️ warn | Production environment warning |

**Note:** By default, only warnings are issued and plugin loading continues.
This accounts for cases where the author's declaration may be overly conservative.

### Control via Environment Variables

```bash
# Compatibility check level
PLUGIN_COMPATIBILITY_CHECK=warn   # Default
PLUGIN_COMPATIBILITY_CHECK=error  # Stop on incompatibility
PLUGIN_COMPATIBILITY_CHECK=ignore # Skip check
```

---

## 5. Update Notifications

### For npm Plugins

- Display version information in Admin UI
- Availability of new versions is provided as reference information
- **Update decisions and execution are the user's responsibility**

### For Local/Private Plugins

- Only version string is displayed
- Update notification feature is not provided

---

## 6. Security Considerations

### Things to Verify Before Installing a Plugin

1. **Author Trustworthiness** - Who developed it
2. **Source Code** - Review if possible
3. **Dependencies** - Check for suspicious dependencies
4. **Activity** - Is it being maintained

### What Authrim Does NOT Provide

- Plugin security audits
- Vulnerability scanning
- Detection of malicious plugins

---

## 7. About Central Registry

### Authrim Does Not Operate a Plugin Registry

Reasons:
- Centralized management is contrary to Authrim's philosophy
- Author identity verification is technically difficult
- Differences would arise between OSS and enterprise use

### Alternatives

- npm registry (public/private)
- GitHub Releases
- Enterprise package repositories

---

## 8. For Third-Party Plugin Developers

### Recommended Practices

1. **Clear Metadata**
   ```typescript
   meta: {
     name: 'Your Plugin Name',
     description: 'What the plugin does',
     author: {
       name: 'Your Name',
       email: 'contact@example.com', // Optional
     },
     license: 'MIT',
     minAuthrimVersion: '1.0.0',
     stability: 'stable',
   }
   ```

2. **Semantic Versioning**
   - Breaking changes in major versions

3. **Testing**
   - Test with multiple Authrim versions

4. **Documentation**
   - Installation instructions
   - Configuration options
   - Known limitations

---

## Changelog

- 2024-12-24: Initial version created
