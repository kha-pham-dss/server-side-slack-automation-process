import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient();

/**
 * @param {string} [parameterPrefix] mặc định process.env.PARAMETER_PREFIX hoặc /slack-dishes
 * @returns {Promise<Record<string, string>>}
 */
export async function loadConfigFromParameterStore(parameterPrefix) {
  const prefix = parameterPrefix || process.env.PARAMETER_PREFIX || '/slack-dishes';
  const pathPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const namePrefix = `${pathPrefix}/`;
  const map = {};
  let nextToken;
  do {
    const res = await ssm.send(
      new GetParametersByPathCommand({
        Path: pathPrefix,
        Recursive: true,
        WithDecryption: true,
        NextToken: nextToken,
        MaxResults: 10,
      })
    );
    for (const p of res.Parameters || []) {
      const name = p.Name?.replace(namePrefix, '') || '';
      if (name && p.Value != null && p.Value !== '') map[name] = p.Value;
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return map;
}
