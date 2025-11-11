# Contributing to Hibana

Thank you for your interest in contributing to Hibana! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Coding Standards](#coding-standards)
- [Submitting Changes](#submitting-changes)
- [Reporting Issues](#reporting-issues)

## Code of Conduct

This project adheres to a code of conduct that all contributors are expected to follow. Please be respectful and constructive in all interactions.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR-USERNAME/hibana.git
   cd hibana
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Set up your development environment** (see [DEVELOPMENT.md](./DEVELOPMENT.md))

## Development Workflow

### 1. Create a Branch

Create a new branch for your feature or bugfix:

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/your-bugfix-name
```

### 2. Make Changes

- Write clean, readable code following our [coding standards](#coding-standards)
- Add tests for new features
- Update documentation as needed
- Ensure all tests pass

### 3. Test Your Changes

```bash
# Run linter
npm run lint

# Run type checking
npm run typecheck

# Run tests
npm run test

# Run tests with coverage
npm run test:coverage

# Build the project
npm run build
```

### 4. Commit Your Changes

Write clear, descriptive commit messages:

```bash
git add .
git commit -m "feat: add support for refresh tokens"
```

**Commit message format:**
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `test:` - Adding or updating tests
- `refactor:` - Code refactoring
- `style:` - Code style changes (formatting, etc.)
- `chore:` - Maintenance tasks

### 5. Push and Create a Pull Request

```bash
git push origin feature/your-feature-name
```

Then create a pull request on GitHub with:
- A clear title describing the change
- A detailed description of what changed and why
- Reference to any related issues

## Coding Standards

### TypeScript

- Use **strict mode** TypeScript
- Define types explicitly (avoid `any`)
- Use interfaces for object shapes
- Use type aliases for union types

### Code Style

- **2 spaces** for indentation
- **Semicolons** required
- **Single quotes** for strings
- Run `npm run format` before committing

### File Organization

```
src/
├── handlers/     # Endpoint handlers
├── utils/        # Utility functions
├── types/        # TypeScript type definitions
└── index.ts      # Main entry point
```

### Testing

- Write unit tests for all utility functions
- Write integration tests for endpoints
- Maintain **≥80% code coverage**
- Use descriptive test names

```typescript
describe('validateClientId', () => {
  it('should accept valid client IDs', () => {
    expect(validateClientId('client-123')).toBe(true);
  });

  it('should reject empty client IDs', () => {
    expect(validateClientId('')).toBe(false);
  });
});
```

### Documentation

- Add JSDoc comments for all exported functions
- Update README.md for user-facing changes
- Update technical docs in `docs/` for architecture changes

```typescript
/**
 * Validates a client ID according to OAuth 2.0 specifications.
 *
 * @param clientId - The client ID to validate
 * @returns True if valid, false otherwise
 */
export function validateClientId(clientId: string): boolean {
  // ...
}
```

## Submitting Changes

### Pull Request Checklist

Before submitting a pull request, ensure:

- [ ] Code follows the style guide
- [ ] All tests pass (`npm run test`)
- [ ] Type checking passes (`npm run typecheck`)
- [ ] Linting passes (`npm run lint`)
- [ ] Code is formatted (`npm run format`)
- [ ] New tests are added for new features
- [ ] Documentation is updated
- [ ] Commit messages are clear and descriptive

### Review Process

1. A maintainer will review your pull request
2. Address any feedback or requested changes
3. Once approved, your PR will be merged

## Reporting Issues

### Bug Reports

When reporting bugs, please include:

- **Description** - Clear description of the issue
- **Steps to reproduce** - Detailed steps to reproduce the bug
- **Expected behavior** - What you expected to happen
- **Actual behavior** - What actually happened
- **Environment** - Node version, OS, etc.
- **Logs** - Any relevant error messages or logs

### Feature Requests

When requesting features, please include:

- **Use case** - Why this feature is needed
- **Proposed solution** - How you think it should work
- **Alternatives** - Any alternative solutions you've considered

## Questions?

If you have questions, please:

1. Check the [documentation](./docs/)
2. Search existing issues
3. Create a new issue with the question label

## License

By contributing to Hibana, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to Hibana! 🔥
