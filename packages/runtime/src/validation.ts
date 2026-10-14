import { parse } from 'acorn'

export interface ValidationIssue {
  message: string
  fieldId: string | null
  source: 'official' | 'guard'
  guardIndex?: number
}

export interface ValidationResult {
  officialFirst: ValidationIssue | null
  issues: ValidationIssue[]
  coverage: { guards: number; evaluated: number; failedToEvaluate: number }
}

export interface ValidationLogger {
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    scope: string,
    msg: string,
    fields?: Record<string, unknown>,
  ): unknown
}

export interface GuardDescriptor {
  index: number
  prelude: string
  test: string
  message: string
  fieldId: string | null
}

type Node = any

function statementsOf(node: Node | null | undefined): Node[] {
  if (!node) {
    return []
  }
  return node.type === 'BlockStatement' ? node.body : [node]
}

function isMessageExpression(node: Node): boolean {
  if (node.type === 'Literal') {
    return typeof node.value === 'string' || typeof node.value === 'number'
  }
  if (node.type === 'Identifier') {
    return true
  }
  return (
    node.type === 'BinaryExpression' &&
    node.operator === '+' &&
    isMessageExpression(node.left) &&
    isMessageExpression(node.right)
  )
}

function alertArgument(statement: Node): Node | null {
  if (statement.type !== 'ExpressionStatement') {
    return null
  }
  const call = statement.expression
  if (
    call?.type !== 'CallExpression' ||
    call.callee?.type !== 'Identifier' ||
    call.callee.name !== 'alert' ||
    call.arguments.length !== 1 ||
    !isMessageExpression(call.arguments[0])
  ) {
    return null
  }
  return call.arguments[0]
}

function focusTargetOf(statements: Node[]): string | null {
  for (const statement of statements) {
    if (statement.type !== 'ExpressionStatement') {
      continue
    }
    const call = statement.expression
    if (call?.type !== 'CallExpression' || call.callee?.type !== 'MemberExpression') {
      continue
    }
    const method = call.callee.property?.name
    if (method !== 'focus') {
      continue
    }
    const target = call.callee.object
    if (
      target?.type === 'CallExpression' &&
      target.callee?.type === 'MemberExpression' &&
      target.callee.property?.name === 'getElementById' &&
      target.arguments[0]?.type === 'Literal'
    ) {
      return String(target.arguments[0].value)
    }
  }
  return null
}

function guardOf(
  source: string,
  consequent: Node,
): { message: string; fieldId: string | null } | null {
  const statements = statementsOf(consequent)
  const alertIndex = statements.findIndex((statement) => alertArgument(statement) !== null)
  if (alertIndex < 0) {
    return null
  }
  const returns = statements
    .slice(alertIndex + 1)
    .some((statement) => statement.type === 'ReturnStatement')
  if (!returns) {
    return null
  }
  const argument = alertArgument(statements[alertIndex]) as Node
  return {
    message: source.slice(argument.start, argument.end),
    fieldId: focusTargetOf(statements),
  }
}

function walk(
  source: string,
  statements: Node[],
  conditions: string[],
  prelude: string[],
  guards: Omit<GuardDescriptor, 'index'>[],
): void {
  for (const statement of statements) {
    if (statement.type === 'VariableDeclaration') {
      prelude.push(source.slice(statement.start, statement.end))
      continue
    }
    if (statement.type === 'BlockStatement') {
      walk(source, statement.body, conditions, prelude, guards)
      continue
    }
    if (statement.type === 'TryStatement') {
      walk(source, statementsOf(statement.block), conditions, prelude, guards)
      walk(source, statementsOf(statement.handler?.body), conditions, prelude, guards)
      walk(source, statementsOf(statement.finalizer), conditions, prelude, guards)
      continue
    }
    if (statement.type !== 'IfStatement') {
      continue
    }
    const test = source.slice(statement.test.start, statement.test.end)
    const guard = guardOf(source, statement.consequent)
    if (guard) {
      guards.push({
        prelude: prelude.join('\n'),
        test: [...conditions, test].map((condition) => `(${condition})`).join(' && '),
        message: guard.message,
        fieldId: guard.fieldId,
      })
    } else {
      walk(source, statementsOf(statement.consequent), [...conditions, test], prelude, guards)
    }
    if (statement.alternate) {
      walk(
        source,
        statementsOf(statement.alternate),
        [...conditions, `!(${test})`],
        prelude,
        guards,
      )
    }
  }
}

export function extractGuards(source: string): GuardDescriptor[] {
  const program = parse(source, {
    ecmaVersion: 5,
    allowReturnOutsideFunction: true,
  }) as unknown as Node
  const first = program.body[0]
  const fn =
    first?.type === 'FunctionDeclaration'
      ? first
      : first?.type === 'ExpressionStatement'
        ? first.expression
        : null
  if (!fn?.body) {
    throw new Error('Validation source does not declare a function.')
  }
  const guards: Omit<GuardDescriptor, 'index'>[] = []
  walk(source, statementsOf(fn.body), [], [], guards)
  return guards.map((guard, index) => ({ ...guard, index }))
}
