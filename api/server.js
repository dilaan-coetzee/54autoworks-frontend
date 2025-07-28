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
const WOO_STORE_API_NONCE = process.env.WOO_STORE_API_NONCE || ''; // This should be empty in Vercel now

// Basic validation for environment variables
if (!WOO_STORE_API_URL || WOO_STORE_API_URL === 'YOUR_WOO_STORE_API_URL') {
    console.error('SERVER ERROR: WOO_STORE_API_URL is not set. Please set it in your environment variables or .env file.');
    process.exit(1);
}
console.log('Server Init: WOO_STORE_API_URL:', WOO_STORE_API_URL);
console.log('Server Init: WOO_STORE_API_NONCE (from env, for reference only):', WOO_STORE_API_NONCE ? 'configured' : 'NOT CONFIGURED (empty)');


// Helper function to forward requests to WooCommerce Store API
async function forwardToWooCommerce(req, res, endpoint, method = 'GET', body = null) {
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

        // Extracting and Forwarding Cart-Token
        const newWooSessionToken = wooResponse.headers.get('woocommerce-session');
        if (newWooSessionToken) {
            res.setHeader('Cart-Token', newWooSessionToken);
            console.log('Server Proxy: Received WC session token in header, setting Cart-Token header for client:', newWooSessionToken);
        } else {
            console.log('Server Proxy: No new WC session token received in headers.');
        }

        // Extracting and Forwarding Nonce
        const responseBody = await wooResponse.json();
        console.log('Server Proxy: Received WC response body:', JSON.stringify(responseBody, null, 2)); // Log full body

        let wcNonceFromResponseBody;
        if (responseBody.nonce) {
            wcNonceFromResponseBody = responseBody.nonce;
            console.log('Server Proxy: Found nonce in WC response body:', wcNonceFromResponseBody);
        } else {
            console.log('Server Proxy: No nonce found in WC response body.');
        }

        const wcNonceFromResponseHeader = wooResponse.headers.get('x-wc-store-api-nonce');
        if (wcNonceFromResponseHeader) {
            console.log('Server Proxy: Found nonce in WC response header (x-wc-store-api-nonce):', wcNonceFromResponseHeader);
            // Prioritize nonce from body, but if not there, use header.
            if (!wcNonceFromResponseBody) {
                wcNonceFromResponseBody = wcNonceFromResponseHeader; // Use header nonce if body nonce is missing
                console.log('Server Proxy: Using nonce from header as body nonce was missing.');
            }
        } else {
            console.log('Server Proxy: No nonce found in WC response header (x-wc-store-api-nonce).');
        }

        // Set the Nonce header for the client if we found one
        if (wcNonceFromResponseBody) {
            res.setHeader('Nonce', wcNonceFromResponseBody);
            console.log('Server Proxy: Setting Nonce header for client:', wcNonceFromResponseBody);
        } else {
            console.log('Server Proxy: No nonce to set in client response header.');
        }

        // Construct the response for the client, including cartToken and nonce in body if available
        const clientResponseData = {
            ...responseBody, // Include all original WC response body data
            cartToken: newWooSessionToken || clientCartToken || responseBody.cartToken, // Best available cart token
            nonce: wcNonceFromResponseBody || clientNonce // Best available nonce
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

        // Extracting and Forwarding Cart-Token
        const newWooSessionToken = cartResponse.headers.get('woocommerce-session');
        if (newWooSessionToken) {
            res.setHeader('Cart-Token', newWooSessionToken);
            console.log('Server /api/init: Set Cart-Token header from /cart response:', newWooSessionToken);
        } else {
            console.log('Server /api/init: No new WC session token received in headers.');
        }

        // Extracting and Forwarding Nonce
        const cartData = await cartResponse.json();
        console.log('Server /api/init: Received cart data from WC:', JSON.stringify(cartData, null, 2)); // Log full body

        let wcNonceFromResponseBody;
        if (cartData.nonce) {
            wcNonceFromResponseBody = cartData.nonce;
            console.log('Server /api/init: Found nonce in WC response body:', wcNonceFromResponseBody);
        } else {
            console.log('Server /api/init: No nonce found in WC response body.');
        }

        const wcNonceFromResponseHeader = cartResponse.headers.get('x-wc-store-api-nonce');
        if (wcNonceFromResponseHeader) {
            console.log('Server /api/init: Found nonce in WC response header (x-wc-store-api-nonce):', wcNonceFromResponseHeader);
            // Prioritize nonce from body, but if not there, use header.
            if (!wcNonceFromResponseBody) {
                wcNonceFromResponseBody = wcNonceFromResponseHeader; // Use header nonce if body nonce is missing
                console.log('Server /api/init: Using nonce from header as body nonce was missing.');
            }
        } else {
            console.log('Server /api/init: No nonce found in WC response header (x-wc-store-api-nonce).');
        }

        // Set the Nonce header for the client if we found one
        if (wcNonceFromResponseBody) {
            res.setHeader('Nonce', wcNonceFromResponseBody);
            console.log('Server /api/init: Setting Nonce header for client:', wcNonceFromResponseBody);
        } else {
            console.log('Server /api/init: No nonce to set in client response header.');
        }

        // Construct the response for the client
        res.status(cartResponse.status).json({
            cart: cartData.cart || cartData, // Ensure 'cart' object is returned if it's nested
            cartToken: newWooSessionToken || req.headers['cart-token'] || cartData.cartToken, // Best available cart token
            nonce: wcNonceFromResponseBody || req.headers['nonce'] // Best available nonce
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
