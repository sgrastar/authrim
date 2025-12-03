/**
 * SCIM 2.0 Filter Query Parser
 *
 * Implements RFC 7644 Section 3.4.2.2 - Filtering
 *
 * Supports:
 * - Comparison operators: eq, ne, co, sw, ew, pr, gt, ge, lt, le
 * - Logical operators: and, or, not
 * - Grouping with parentheses
 * - Attribute paths (e.g., emails[type eq "work"].value)
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7644#section-3.4.2.2
 */

import type { ScimFilterNode } from '../types/scim';

/**
 * Tokenizer for SCIM filter expressions
 */
class ScimFilterTokenizer {
  private input: string;
  private position = 0;
  private current: string | null = null;

  constructor(input: string) {
    this.input = input.trim();
    this.advance();
  }

  private advance(): void {
    if (this.position < this.input.length) {
      this.current = this.input[this.position];
      this.position++;
    } else {
      this.current = null;
    }
  }

  private peek(offset = 0): string | null {
    const pos = this.position + offset;
    return pos < this.input.length ? this.input[pos] : null;
  }

  private skipWhitespace(): void {
    while (this.current && /\s/.test(this.current)) {
      this.advance();
    }
  }

  public nextToken(): { type: string; value: string } | null {
    this.skipWhitespace();

    if (!this.current) {
      return null;
    }

    // String literal
    if (this.current === '"') {
      return this.readString();
    }

    // Parentheses
    if (this.current === '(' || this.current === ')') {
      const token = { type: this.current, value: this.current };
      this.advance();
      return token;
    }

    // Brackets for array indexing
    if (this.current === '[' || this.current === ']') {
      const token = { type: this.current, value: this.current };
      this.advance();
      return token;
    }

    // Dot for path navigation
    if (this.current === '.') {
      const token = { type: 'DOT', value: '.' };
      this.advance();
      return token;
    }

    // Keywords, operators, or attribute names
    return this.readIdentifier();
  }

  private readString(): { type: string; value: string } {
    let value = '';
    this.advance(); // Skip opening quote

    while (this.current && this.current !== '"') {
      if (this.current === '\\' && this.peek() === '"') {
        this.advance();
        value += '"';
        this.advance();
      } else {
        value += this.current;
        this.advance();
      }
    }

    this.advance(); // Skip closing quote
    return { type: 'STRING', value };
  }

  private readIdentifier(): { type: string; value: string } {
    let value = '';

    while (this.current && /[a-zA-Z0-9_.:$-]/.test(this.current)) {
      value += this.current;
      this.advance();
    }

    const upperValue = value.toUpperCase();

    // Check for operators
    if (['EQ', 'NE', 'CO', 'SW', 'EW', 'PR', 'GT', 'GE', 'LT', 'LE'].includes(upperValue)) {
      return { type: 'OPERATOR', value: upperValue.toLowerCase() };
    }

    // Check for logical operators
    if (['AND', 'OR', 'NOT'].includes(upperValue)) {
      return { type: 'LOGICAL', value: upperValue.toLowerCase() };
    }

    // Check for boolean values
    if (['TRUE', 'FALSE'].includes(upperValue)) {
      return { type: 'BOOLEAN', value: upperValue.toLowerCase() === 'true' ? 'true' : 'false' };
    }

    // Check for null
    if (upperValue === 'NULL') {
      return { type: 'NULL', value: 'null' };
    }

    // Check for numbers
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      return { type: 'NUMBER', value };
    }

    // Otherwise, it's an attribute path
    return { type: 'ATTRIBUTE', value };
  }

  public hasMore(): boolean {
    this.skipWhitespace();
    return this.current !== null;
  }
}

/**
 * Parser for SCIM filter expressions
 */
export class ScimFilterParser {
  private tokenizer: ScimFilterTokenizer;
  private currentToken: { type: string; value: string } | null = null;

  constructor(filter: string) {
    this.tokenizer = new ScimFilterTokenizer(filter);
    this.advance();
  }

  private advance(): void {
    this.currentToken = this.tokenizer.nextToken();
  }

  private expect(type: string): void {
    if (!this.currentToken || this.currentToken.type !== type) {
      throw new Error(`Expected ${type} but got ${this.currentToken?.type || 'EOF'}`);
    }
  }

  /**
   * Parse the filter expression
   */
  public parse(): ScimFilterNode {
    return this.parseLogicalOr();
  }

  private parseLogicalOr(): ScimFilterNode {
    let left = this.parseLogicalAnd();

    while (this.currentToken?.type === 'LOGICAL' && this.currentToken.value === 'or') {
      this.advance();
      const right = this.parseLogicalAnd();
      left = {
        type: 'logical',
        operator: 'or',
        left,
        right,
      };
    }

    return left;
  }

  private parseLogicalAnd(): ScimFilterNode {
    let left = this.parseLogicalNot();

    while (this.currentToken?.type === 'LOGICAL' && this.currentToken.value === 'and') {
      this.advance();
      const right = this.parseLogicalNot();
      left = {
        type: 'logical',
        operator: 'and',
        left,
        right,
      };
    }

    return left;
  }

  private parseLogicalNot(): ScimFilterNode {
    if (this.currentToken?.type === 'LOGICAL' && this.currentToken.value === 'not') {
      this.advance();
      const expression = this.parsePrimary();
      return {
        type: 'logical',
        operator: 'not',
        expression,
      };
    }

    return this.parsePrimary();
  }

  private parsePrimary(): ScimFilterNode {
    // Grouping with parentheses
    if (this.currentToken?.type === '(') {
      this.advance();
      const expr = this.parseLogicalOr();
      this.expect(')');
      this.advance();
      return {
        type: 'grouping',
        expression: expr,
      };
    }

    // Attribute comparison
    if (this.currentToken?.type === 'ATTRIBUTE') {
      return this.parseComparison();
    }

    throw new Error(`Unexpected token: ${this.currentToken?.type}`);
  }

  private parseComparison(): ScimFilterNode {
    const attribute = this.currentToken!.value;
    this.advance();

    // Handle value path (e.g., emails[type eq "work"].value)
    if (this.currentToken?.type === '[') {
      return this.parseValuePath(attribute);
    }

    // Handle 'pr' (present) operator
    if (this.currentToken?.type === 'OPERATOR' && this.currentToken.value === 'pr') {
      this.advance();
      return {
        type: 'comparison',
        operator: 'pr',
        attribute,
      };
    }

    // Standard comparison
    if (this.currentToken?.type === 'OPERATOR') {
      const operator = this.currentToken.value as any;
      this.advance(); // Move to value token

      // After advance(), currentToken is now the value token (not OPERATOR anymore)
      const valueToken = this.currentToken;
      let value: any;

      if (valueToken?.type === 'STRING') {
        value = valueToken.value;
      } else if (valueToken?.type === 'NUMBER') {
        value = parseFloat(valueToken.value);
      } else if (valueToken?.type === 'BOOLEAN') {
        value = valueToken.value === 'true';
      } else if (valueToken?.type === 'NULL') {
        value = null;
      } else {
        throw new Error(`Expected value but got ${valueToken?.type}`);
      }

      this.advance();

      return {
        type: 'comparison',
        operator,
        attribute,
        value,
      };
    }

    throw new Error(`Expected operator but got ${this.currentToken?.type}`);
  }

  private parseValuePath(attribute: string): ScimFilterNode {
    this.expect('[');
    this.advance();

    const filter = this.parseLogicalOr();

    this.expect(']');
    this.advance();

    // Optional: handle .value or other sub-attributes
    let subAttribute: string | undefined;
    if (this.currentToken?.type === 'DOT') {
      this.advance();
      this.expect('ATTRIBUTE');
      subAttribute = this.currentToken!.value;
      this.advance();
    }

    return {
      type: 'valuePath',
      attribute,
      expression: filter,
      value: subAttribute,
    };
  }
}

/**
 * Parse a SCIM filter string into an AST
 */
export function parseScimFilter(filter: string): ScimFilterNode {
  try {
    const parser = new ScimFilterParser(filter);
    return parser.parse();
  } catch (error) {
    throw new Error(
      `Invalid SCIM filter: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Convert SCIM filter AST to SQL WHERE clause
 *
 * This is a basic implementation that maps SCIM attributes to database columns.
 * You may need to customize this based on your database schema.
 */
export function filterToSql(
  node: ScimFilterNode,
  attributeMap: Record<string, string> = {}
): { sql: string; params: any[] } {
  const params: any[] = [];

  function nodeToSql(n: ScimFilterNode): string {
    switch (n.type) {
      case 'comparison': {
        const column = attributeMap[n.attribute!] || n.attribute!;
        const paramIndex = params.length;

        switch (n.operator) {
          case 'eq':
            params.push(n.value);
            return `${column} = ?${paramIndex + 1}`;
          case 'ne':
            params.push(n.value);
            return `${column} != ?${paramIndex + 1}`;
          case 'co':
            params.push(`%${n.value}%`);
            return `${column} LIKE ?${paramIndex + 1}`;
          case 'sw':
            params.push(`${n.value}%`);
            return `${column} LIKE ?${paramIndex + 1}`;
          case 'ew':
            params.push(`%${n.value}`);
            return `${column} LIKE ?${paramIndex + 1}`;
          case 'pr':
            return `${column} IS NOT NULL`;
          case 'gt':
            params.push(n.value);
            return `${column} > ?${paramIndex + 1}`;
          case 'ge':
            params.push(n.value);
            return `${column} >= ?${paramIndex + 1}`;
          case 'lt':
            params.push(n.value);
            return `${column} < ?${paramIndex + 1}`;
          case 'le':
            params.push(n.value);
            return `${column} <= ?${paramIndex + 1}`;
          default:
            throw new Error(`Unsupported operator: ${n.operator}`);
        }
      }

      case 'logical': {
        if (n.operator === 'not') {
          return `NOT (${nodeToSql(n.expression!)})`;
        }
        const left = nodeToSql(n.left!);
        const right = nodeToSql(n.right!);
        const op = n.operator === 'and' ? 'AND' : 'OR';
        return `(${left} ${op} ${right})`;
      }

      case 'grouping':
        return `(${nodeToSql(n.expression!)})`;

      case 'valuePath':
        // For complex attributes like emails[type eq "work"].value
        // This requires JSON querying or normalized tables
        // Basic implementation for demonstration
        throw new Error('Value path filters require custom implementation based on your schema');

      default:
        throw new Error(`Unsupported node type: ${(n as any).type}`);
    }
  }

  const sql = nodeToSql(node);
  return { sql, params };
}

/**
 * Validate SCIM filter syntax
 */
export function validateScimFilter(filter: string): { valid: boolean; error?: string } {
  try {
    parseScimFilter(filter);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Invalid filter',
    };
  }
}
