#!/bin/bash
# =============================================================================
# Custom k6 Binary Build Script for Passkey Load Testing
# =============================================================================
#
# Overview:
#   Builds a custom k6 binary including the xk6-passkeys extension (Authrim fork).
#   This binary enables ECDSA P-256 signature generation for Passkey authentication
#   within k6 scripts.
#
#   Fork-specific features:
#   - ExportCredential() / ImportCredential(): Share credentials between setup() and default()
#   - ExportRelyingParty() / ImportRelyingParty(): Serialize RP configuration
#
# Requirements:
#   - Go 1.23+ (https://go.dev/dl/)
#   - Git
#   - Make (optional)
#   * Docker is not required
#
# Usage:
#   ./scripts/build-k6-passkeys.sh
#
# Output:
#   ./bin/k6-passkeys (custom k6 binary)
#
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_DIR="${PROJECT_ROOT}/bin"
OUTPUT_BINARY="${OUTPUT_DIR}/k6-passkeys"

echo "=============================================="
echo "🔨 Building k6 with xk6-passkeys extension"
echo "=============================================="
echo ""

# Check Go version
if ! command -v go &> /dev/null; then
    echo "❌ Error: Go is not installed"
    echo "   Please install Go 1.23+ from https://go.dev/dl/"
    exit 1
fi

GO_VERSION=$(go version | grep -oE 'go[0-9]+\.[0-9]+' | sed 's/go//')
GO_MAJOR=$(echo "$GO_VERSION" | cut -d. -f1)
GO_MINOR=$(echo "$GO_VERSION" | cut -d. -f2)

if [ "$GO_MAJOR" -lt 1 ] || ([ "$GO_MAJOR" -eq 1 ] && [ "$GO_MINOR" -lt 23 ]); then
    echo "❌ Error: Go 1.23+ is required (found: go${GO_VERSION})"
    exit 1
fi

echo "✅ Go version: go${GO_VERSION}"

# Install xk6
echo ""
echo "📦 Installing xk6 build tool..."
go install go.k6.io/xk6/cmd/xk6@latest

# Verify PATH
if ! command -v xk6 &> /dev/null; then
    export PATH="$PATH:$(go env GOPATH)/bin"
fi

# Execute build
echo ""
echo "🔨 Building k6 with passkeys extension (Authrim fork)..."
echo "   Extension: github.com/authrim/xk6-passkeys (local)"
echo "   Source: ${PROJECT_ROOT}/extensions/xk6-passkeys"

# Build in temporary directory (to avoid conflicts with existing go.mod)
BUILD_DIR=$(mktemp -d)
cd "$BUILD_DIR"

# Build using local fork
xk6 build --with github.com/authrim/xk6-passkeys="${PROJECT_ROOT}/extensions/xk6-passkeys"

# Create output directory and move binary
echo ""
echo "📁 Moving k6 binary to ${OUTPUT_BINARY}"
mkdir -p "$OUTPUT_DIR"
mv ./k6 "$OUTPUT_BINARY"

# Remove temporary directory
cd "$PROJECT_ROOT"
rm -rf "$BUILD_DIR"

# Grant execute permission
chmod +x "$OUTPUT_BINARY"

# Verify version
echo ""
echo "✅ Build complete!"
echo ""
echo "k6 version:"
"$OUTPUT_BINARY" version
echo ""
echo "=============================================="
echo "Usage:"
echo "  ${OUTPUT_BINARY} run --env BASE_URL=... scripts/test-passkey-full-login-benchmark.js"
echo "=============================================="
