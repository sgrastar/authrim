import { z } from 'zod';

const profile = z.string().regex(/^[A-Za-z0-9_+=,.@-]{1,128}$/u);
const absolute = z
  .string()
  .max(4096)
  .startsWith('/')
  .refine((value) => !Array.from(value).some((character) => character.charCodeAt(0) < 32));
const origin = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
    } catch {
      return false;
    }
  });
const path = z
  .string()
  .max(256)
  .regex(/^\/[A-Za-z0-9_~./-]*$/u)
  .refine(
    (value) =>
      !value.includes('//') && !value.split('/').some((part) => part === '.' || part === '..')
  );
const ui = z.strictObject({
  login: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('disabled') }),
    z.strictObject({ mode: z.literal('embedded-rehearsal') }),
    z.strictObject({
      mode: z.literal('external'),
      baseUrl: origin,
      clientId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u),
      paths: z.strictObject({ login: path, reauth: path }),
    }),
  ]),
  admin: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('disabled') }),
    z.strictObject({ mode: z.literal('external'), baseUrl: origin }),
  ]),
});
const common = {
  accountId: z.string().regex(/^\d{12}$/u),
  region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/u),
};
export const awsConfigurationInputSchema = z
  .discriminatedUnion('database', [
    z.strictObject({
      ...common,
      database: z.literal('aurora-dsql'),
      hostname: z.string().regex(/^[a-z0-9]{26}\.dsql\.[a-z0-9-]+\.on\.aws$/u),
      user: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u),
    }),
    z.strictObject({
      ...common,
      database: z.literal('postgresql'),
      name: z.string().regex(/^[a-z][a-z0-9-]{0,27}$/u),
      role: z.enum(['primary', 'secondary']),
      mode: z.enum(['browser-rehearsal', 'existing-issuer']),
      bootstrapProfile: profile,
      bootstrapPrincipalArn: z
        .string()
        .regex(/^arn:aws:iam::\d{12}:(?:user|role)\/[A-Za-z0-9/+=,.@_-]+$/u),
      operatorProfile: profile,
      caBundlePath: absolute,
      s3GatewayPrefixListId: z.string().regex(/^pl-[a-f0-9]{8,17}$/u),
      authState: z.strictObject({ backend: z.enum(['postgresql', 'dynamodb']) }).optional(),
      dynamoDbGatewayPrefixListId: z
        .string()
        .regex(/^pl-[a-f0-9]{8,17}$/u)
        .optional(),
      components: z.strictObject({ loginUi: z.literal(false), adminUi: z.literal(false) }),
      ui,
      issuer: z
        .strictObject({
          host: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u),
          certificateArn: z
            .string()
            .regex(/^arn:aws:acm:[a-z0-9-]+:\d{12}:certificate\/[a-f0-9-]+$/u),
          inputSecretArn: z
            .string()
            .regex(/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@!-]+$/u),
          inputSecretVersionId: z.string().regex(/^[A-Za-z0-9-]{32,64}$/u),
        })
        .optional(),
      fixture: z
        .strictObject({
          directory: absolute,
          descriptorSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        })
        .optional(),
    }),
  ])
  .superRefine((value, ctx) => {
    const invalid = () => ctx.addIssue({ code: 'custom', message: 'Invalid configuration' });
    if (value.database === 'aurora-dsql') {
      if (!value.hostname.endsWith(`.dsql.${value.region}.on.aws`)) invalid();
    } else {
      if (value.authState?.backend === 'dynamodb') {
        if (!value.dynamoDbGatewayPrefixListId) invalid();
      } else if (value.dynamoDbGatewayPrefixListId !== undefined) invalid();
      if (!value.bootstrapPrincipalArn.startsWith(`arn:aws:iam::${value.accountId}:`)) invalid();
      if (value.mode === 'browser-rehearsal') {
        if (value.region !== 'ap-northeast-1' || value.issuer || value.fixture) invalid();
      } else {
        if (!value.issuer || !value.fixture || value.ui.login.mode === 'embedded-rehearsal')
          invalid();
        if (
          value.issuer &&
          (!value.issuer.certificateArn.startsWith(
            `arn:aws:acm:${value.region}:${value.accountId}:`
          ) ||
            !value.issuer.inputSecretArn.startsWith(
              `arn:aws:secretsmanager:${value.region}:${value.accountId}:`
            ))
        )
          invalid();
      }
    }
  });

/** Reject credentials and unknown nested fields before creating any local files. */
export function parseAwsConfigurationInput(value: unknown) {
  return awsConfigurationInputSchema.parse(value);
}

export type AwsConfigurationInput = z.infer<typeof awsConfigurationInputSchema>;
