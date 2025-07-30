const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors'); // Import the cors package

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to enable CORS for all origins
app.use(cors());

// Middleware to parse JSON request bodies
app.use(express.json());

// WooCommerce Store API details (replace with your actual details)
const WOO_STORE_API_URL = process.env.WOO_STORE_API_URL || 'YOUR_WOO_STORE_API_URL';
// WOO_STORE_API_NONCE should NOT be set in Vercel environment variables for dynamic nonces.
const WOO_STORE_API_NONCE = process.env.WOO_STORE_API_NONCE || ''; 

// Basic validation for environment variables
if (!WOO_STORE_API_URL || WOO_STORE_API_URL === 'YOUR_WOO_STORE_API_URL') {
    console.error('SERVER ERROR: WOO_STORE_API_URL is not set. Please set it in your environment variables or .env file.');
    process.exit(1);
}
console.log('Server Init: WOO_STORE_API_URL:', WOO_STORE_API_URL);
console.log('Server Init: WOO_STORE_API_NONCE (from env, should be empty for dynamic nonce):', WOO_STORE_API_NONCE ? 'configured' : 'NOT CONFIGURED (empty)');


// Helper function to forward requests to WooCommerce Store API
async function forwardToWooCommerce(req, res, endpoint, method = 'GET', body = null) {
    console.log(`Server Proxy: >>> ENTERING forwardToWooCommerce for ${endpoint} <<<`); // NEW LOG
    const url = `${WOO_STORE_API_URL}${endpoint}`;
    console.log(`Server Proxy: Attempting ${method} request to: ${url}`);

    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate', // Prevent caching
        'Pragma': 'no-cache',
        'Expires': '0'
    };

    // Forward existing Cart-Token from client if available
    const clientCartToken = req.headers['cart-token'];
    if (clientCartToken) {
        headers['woocommerce-session'] = clientCartToken;
        console.log('Server Proxy: Forwarding client Cart-Token:', clientCartToken);
    } else {
        console.log('Server Proxy: No client Cart-Token to forward.');
    }

    // Forward dynamic Nonce from client if available. This is the primary source.
    const clientNonce = req.headers['nonce'];
    if (clientNonce) {
        headers['x-wc-store-api-nonce'] = clientNonce;
        console.log('Server Proxy: Forwarding client Nonce:', clientNonce);
    } else {
        console.log('Server Proxy: No client Nonce to forward.');
    }

    const fetchOptions = {
        method: method,
        headers: headers,
        // credentials: 'include' // Important for cookies/sessions, but might cause CORS issues if not handled correctly by WC
    };

    if (body) {
        fetchOptions.body = JSON.stringify(body);
        console.log('Server Proxy: Request body sent to WC:', fetchOptions.body);
    }

    try {
        const wooResponse = await fetch(url, fetchOptions);
        console.log(`Server Proxy: WC response status for ${endpoint}: ${wooResponse.status}`);
        
        // --- EXTREME DEBUG LOGGING: Log ALL response headers from WooCommerce ---
        console.log(`Server Proxy: RAW WC Response Headers for ${endpoint}:`);
        for (const [key, value] of wooResponse.headers.entries()) {
            console.log(`  ${key}: ${value}`);
        }
        // --- END EXTREME DEBUG LOGGING ---

        // --- Extracting and Forwarding Cart-Token (Prioritize woocommerce-session header, then Set-Cookie) ---
        let newWooSessionToken = wooResponse.headers.get('woocommerce-session');
        if (newWooSessionToken) {
            console.log('Server Proxy: Found WC session token in woocommerce-session header:', newWooSessionToken);
        } else {
            // If not found in direct header, check Set-Cookie headers
            const setCookieHeaders = wooResponse.headers.raw()['set-cookie'];
            if (setCookieHeaders && setCookieHeaders.length > 0) {
                console.log('Server Proxy: Found Set-Cookie headers:', setCookieHeaders);
                const wooSessionCookie = setCookieHeaders.find(cookie => cookie.includes('woocommerce-session='));
                if (wooSessionCookie) {
                    const sessionValueMatch = wooSessionCookie.match(/woocommerce-session=([^;]+)/);
                    if (sessionValueMatch && sessionValueMatch[1]) {
                        newWooSessionToken = sessionValueMatch[1];
                        console.log('Server Proxy: Extracted WC session token from Set-Cookie:', newWooSessionToken);
                    }
                }
            } else {
                console.log('Server Proxy: No Set-Cookie headers found.');
            }
        }

        if (newWooSessionToken) {
            res.setHeader('Cart-Token', newWooSessionToken);
            console.log('Server Proxy: Setting Cart-Token header for client:', newWooSessionToken);
        } else {
            console.log('Server Proxy: No new WC session token to set for client.');
        }
        // --- End Cart-Token Extraction ---

        const responseBody = await wooResponse.json();
        console.log(`Server Proxy: Received WC response body for ${endpoint}:`, JSON.stringify(responseBody, null, 2)); // Log full body

        // --- Nonce Extraction Logic (Prioritize x-wc-store-api-nonce header, then nonce in body) ---
        let wcNonceToForward = wooResponse.headers.get('x-wc-store-api-nonce');
        if (wcNonceToForward) {
            console.log('Server Proxy: Found nonce in WC response header (x-wc-store-api-nonce):', wcNonceToForward);
        } else if (responseBody.nonce) {
            wcNonceToForward = responseBody.nonce;
            console.log('Server Proxy: Found nonce in WC response body:', wcNonceToForward);
        } else {
            console.log('Server Proxy: No nonce found in WC response header or body.');
        }

        // Set the Nonce header for the client if we found one
        if (wcNonceToForward) {
            res.setHeader('Nonce', wcNonceToForward);
            console.log('Server Proxy: Setting Nonce header for client:', wcNonceToForward);
        } else {
            console.log('Server Proxy: No nonce to set in client response header.');
        }
        // --- End Nonce Extraction Logic ---

        // --- CRITICAL FIX FOR /products ENDPOINT (already implemented, re-confirming) ---
        // If the endpoint is /products, just return the raw array.
        // Do NOT wrap it in an object, as this causes the frontend TypeError.
        if (endpoint === '/products') {
            console.log('Server Proxy: Directly forwarding products array to client.');
            res.status(wooResponse.status).json(responseBody);
            return; // Exit function after sending response
        }
        // --- END CRITICAL FIX ---

        // For other endpoints (like cart, add-item, etc.), continue wrapping to include cartToken and nonce
        const clientResponseData = {
            ...responseBody, // Include all original WC response body data
            cartToken: newWooSessionToken || clientCartToken || responseBody.cartToken, // Best available cart token
            nonce: wcNonceToForward || clientNonce // Best available nonce
        };

        res.status(wooResponse.status).json(clientResponseData);

    } catch (error) {
        console.error(`Server ERROR: Failed to forward request to WooCommerce ${endpoint}:`, error);
        console.error('Server ERROR details:', error.message, error.stack);
        res.status(500).json({ message: 'Failed to connect to WooCommerce API', error: error.message });
    }
}

// Endpoint to initialize cart session and get products
app.get('/api/init', async (req, res) => {
    console.log('Server /api/init: >>> ENTERING /api/init <<<'); // NEW LOG
    console.log('Server /api/init: Received request.');
    try {
        // Fetch cart data to get initial session and count
        const cartResponse = await fetch(`${WOO_STORE_API_URL}/cart`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
                // Forward client's existing Cart-Token if available
                'woocommerce-session': req.headers['cart-token'] || undefined,
                // Forward client's existing Nonce if available
                'x-wc-store-api-nonce': req.headers['nonce'] || undefined 
            }
        });

        console.log(`Server /api/init: WooCommerce /cart response status: ${cartResponse.status}`);

        // --- EXTREME DEBUG LOGGING: Log ALL response headers from WooCommerce ---
        console.log('Server /api/init: RAW WC Response Headers:');
        for (const [key, value] of cartResponse.headers.entries()) {
            console.log(`  ${key}: ${value}`);
        }
        // --- END EXTREME DEBUG LOGGING ---

        // --- Extracting and Forwarding Cart-Token (Prioritize woocommerce-session header, then Set-Cookie) ---
        let newWooSessionToken = cartResponse.headers.get('woocommerce-session');
        if (newWooSessionToken) {
            console.log('Server /api/init: Found WC session token in woocommerce-session header:', newWooSessionToken);
        } else {
            // If not found in direct header, check Set-Cookie headers
            const setCookieHeaders = cartResponse.headers.raw()['set-cookie'];
            if (setCookieHeaders && setCookieHeaders.length > 0) {
                console.log('Server /api/init: Found Set-Cookie headers:', setCookieHeaders);
                const wooSessionCookie = setCookieHeaders.find(cookie => cookie.includes('woocommerce-session='));
                if (wooSessionCookie) {
                    const sessionValueMatch = wooSessionCookie.match(/woocommerce-session=([^;]+)/);
                    if (sessionValueMatch && sessionValueMatch[1]) {
                        newWooSessionToken = sessionValueMatch[1];
                        console.log('Server /api/init: Extracted WC session token from Set-Cookie:', newWooSessionToken);
                    }
                }
            } else {
                console.log('Server /api/init: No Set-Cookie headers found.');
            }
        }

        if (newWooSessionToken) {
            res.setHeader('Cart-Token', newWooSessionToken);
            console.log('Server /api/init: Setting Cart-Token header for client:', newWooSessionToken);
        } else {
            console.log('Server /api/init: No new WC session token to set for client.');
        }
        // --- End Cart-Token Extraction ---

        // Extracting and Forwarding Nonce
        const cartData = await cartResponse.json();
        console.log('Server /api/init: Received cart data from WC:', JSON.stringify(cartData, null, 2)); // Log full body

        let wcNonceToForward = cartResponse.headers.get('x-wc-store-api-nonce');
        if (wcNonceToForward) {
            console.log('Server /api/init: Found nonce in WC response header (x-wc-store-api-nonce):', wcNonceToForward);
        } else if (cartData.nonce) {
            wcNonceToForward = cartData.nonce;
            console.log('Server /api/init: Found nonce in WC response body:', wcNonceToForward);
        } else {
            console.log('Server /api/init: No nonce found in WC response header or body.');
        }

        // Set the Nonce header for the client if we found one
        if (wcNonceToForward) {
            res.setHeader('Nonce', wcNonceToForward);
            console.log('Server /api/init: Setting Nonce header for client:', wcNonceToForward);
        } else {
            console.log('Server /api/init: No nonce to set in client response header.');
        }

        // Construct the response for the client
        res.status(cartResponse.status).json({
            cart: cartData.cart || cartData, // Ensure 'cart' object is returned if it's nested
            cartToken: newWooSessionToken || req.headers['cart-token'] || cartData.cartToken, // Best available cart token
            nonce: wcNonceToForward || req.headers['nonce'] // Best available nonce
        });

    } catch (error) {
        console.error('Server ERROR: Error in /api/init:', error);
        console.error('Server ERROR details for /api/init:', error.message, error.stack);
        res.status(500).json({ message: 'Failed to initialize cart session', error: error.message });
    }
});


// Endpoint to get all products
app.get('/api/products', async (req, res) => {
    await forwardToWooCommerce(req, res, '/products');
});

// Endpoint to add product to cart
app.post('/api/cart/add', async (req, res) => {
    const { productId, quantity } = req.body;
    await forwardToWooCommerce(req, res, '/cart/add-item', 'POST', {
        id: productId,
        quantity: quantity
    });
});

// Endpoint to update cart item quantity
app.post('/api/cart/update-item', async (req, res) => {
    const { key, quantity } = req.body;
    await forwardToWooCommerce(req, res, `/cart/update-item`, 'POST', {
        key: key,
        quantity: quantity
    });
});

// Endpoint to remove item from cart
app.post('/api/cart/remove-item', async (req, res) => {
    const { key } = req.body;
    await forwardToWooCommerce(req, res, `/cart/remove-item`, 'POST', {
        key: key
    });
});

// Endpoint to fetch cart contents
app.get('/api/cart', async (req, res) => {
    await forwardToWooCommerce(req, res, '/cart');
});

// Endpoint to fetch exchange rates (example, replace with actual API if needed)
app.get('/api/exchange-rates', (req, res) => {
    // In a real application, you'd fetch this from a reliable exchange rate API
    res.json({
        USD: 1,
        ZAR: 19.00, // Example rate
        EUR: 0.92,
        GBP: 0.79
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
});
