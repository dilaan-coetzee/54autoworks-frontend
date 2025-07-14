// scripts/proxy.js
// This file will contain the logic to make proxied requests from the frontend.

// This function will be called by shop.js and cart.js to make API calls
// It bypasses server-side CORS issues by proxying through the same origin.
async function makeProxiedRequest(method, path, body = null, cartToken = null) {
    // The path should be relative to the frontend's root, e.g., '/api/products'
    const proxyUrl = path; 

    const headers = {
        'Content-Type': 'application/json',
    };

    if (cartToken) {
        headers['Cart-Token'] = cartToken;
    }

    const options = {
        method: method,
        headers: headers,
    };

    if (body) {
        options.body = JSON.stringify(body);
    }

    try {
        console.log(`[FRONTEND PROXY] Making request to: ${proxyUrl} with method ${method}`);
        console.log('[FRONTEND PROXY] Headers:', headers);
        if (body) console.log('[FRONTEND PROXY] Body:', body);

        const response = await fetch(proxyUrl, options);

        // Extract WooCommerce session token if present
        const newWooSessionToken = response.headers.get('woocommerce-session');
        if (newWooSessionToken) {
            // Store it in localStorage for persistence across pages/sessions
            localStorage.setItem('wooCartToken', newWooSessionToken);
            console.log('[FRONTEND PROXY] Updated wooCartToken in localStorage:', newWooSessionToken);
        }

        // Handle custom Cart-Token header from proxy response
        const newCartToken = response.headers.get('cart-token');
        if (newCartToken) {
            localStorage.setItem('wooCartToken', newCartToken);
            console.log('[FRONTEND PROXY] Updated wooCartToken from Cart-Token header:', newCartToken);
        }


        // If the response is 204 No Content (like for remove-item success)
        if (response.status === 204) {
            return { status: 204, ok: true }; // Return a success indicator
        }

        const data = await response.json();
        if (!response.ok) {
            console.error(`[FRONTEND PROXY] API Error (${response.status}):`, data);
            throw new Error(data.message || `API request failed with status ${response.status}`);
        }
        return data;

    } catch (error) {
        console.error('[FRONTEND PROXY] Error during proxied request:', error);
        throw error; // Re-throw to be caught by calling function
    }
}
