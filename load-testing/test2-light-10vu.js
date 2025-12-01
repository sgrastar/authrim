import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

const BASE_URL = 'https://conformance.authrim.com';
const refreshTokens = new SharedArray('refresh_tokens', function() {
  return JSON.parse(open('./seeds/refresh_tokens.json'));
});

export const options = {
  scenarios: {
    refresh_test: {
      executor: 'constant-vus',
      vus: 10,
      duration: '30s',
    },
  },
};

// Track current refresh token for each VU (persists across iterations)
const currentTokens = {};

export default function() {
  const tokenIndex = __VU - 1;

  // Initialize token for this VU on first iteration
  if (!currentTokens[__VU]) {
    if (tokenIndex >= refreshTokens.length) {
      console.error(`VU ${__VU}: No refresh token available`);
      return;
    }
    currentTokens[__VU] = {
      token: refreshTokens[tokenIndex].token,
      client_id: refreshTokens[tokenIndex].client_id,
      client_secret: refreshTokens[tokenIndex].client_secret,
    };
  }

  const tokenData = currentTokens[__VU];

  const payload = {
    grant_type: 'refresh_token',
    refresh_token: tokenData.token,
    client_id: tokenData.client_id,
    client_secret: tokenData.client_secret,
  };

  const response = http.post(
    `${BASE_URL}/token`,
    payload,
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );

  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'has access_token': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.access_token !== undefined;
      } catch {
        return false;
      }
    },
    'has new refresh_token': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.refresh_token !== undefined && body.refresh_token !== tokenData.token;
      } catch {
        return false;
      }
    },
  });

  if (success && response.status === 200) {
    // Update to use the new refresh token for next iteration (token rotation)
    try {
      const body = JSON.parse(response.body);
      if (body.refresh_token) {
        currentTokens[__VU].token = body.refresh_token;
      }
    } catch (err) {
      console.error(`VU ${__VU}: Failed to parse response`);
    }
  } else {
    console.error(`VU ${__VU}: Request failed`);
    console.error(`Status: ${response.status}`);
    console.error(`Response: ${response.body}`);
  }

  sleep(1);
}
