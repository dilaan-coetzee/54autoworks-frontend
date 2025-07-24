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
const WOO_STORE_API_URL = process.env.WOO_STORE_API_URL || 'YOUR_WOO_STORE_API_URL'; // e.g., 'https://yourdomain.com/wp-json/wc/store'
// WOO_STORE_API_NONCE is no longer explicitly used for injecting into outgoing requests.
// It remains here only for logging/reference, but should NOT be relied upon for dynamic nonces.
const WOO_STORE_API_NONCE = process.env.WOO_STORE_API_NONCE || ''; 

// Basic validation for environment variables
if (!WOO_STORE_API_URL || WOO_STORE_API_URL === 'YOUR_WOO_STORE_API_URL') {
    console.error('SERVER ERROR: WOO_STORE_API_URL is not set. Please set it in your environment variables or .env file.');
    process.exit(1);
}
console.log('Server: WOO_STORE_API_URL:', WOO_STORE_API_URL);
console.log('Server: WOO_STORE_API_NONCE (from env, for reference only):', WOO_STORE_API_NONCE ? 'configured' : 'NOT CONFIGURED (empty)');


// Helper function to forward requests to WooCommerce Store API
async function forwardToWooCommerce(req, res, endpoint, method = 'GET', body = null) {
    const url = `${WOO_STORE_API_URL}${endpoint}`;
    console.log(`Server: Proxying ${method} request to: ${url}`);

    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate', // Prevent caching
        'Pragma': 'no-cache',
        'Expires': '0'
    };

    // Forward existing Cart-Token from client if available
    if (req.headers['cart-token']) {
        headers['woocommerce-session'] = req.headers['cart-token'];
        console.log('Server: Forwarding existing Cart-Token:', req.headers['cart-token']);
    }

    // --- DYNAMIC NONCE HANDLING ---
    // Only forward nonce if client provides it. The frontend is responsible for getting the dynamic nonce.
    if (req.headers['nonce']) {
        headers['x-wc-store-api-nonce'] = req.headers['nonce'];
        console.log('Server: Forwarding Nonce from client:', req.headers['nonce']);
    } else {
        console.warn('Server: No Nonce received from client for this request.');
    }
    // --- END DYNAMIC NONCE HANDLING ---

    const fetchOptions = {
        method: method,
        headers: headers,
        // credentials: 'include' // Important for cookies/sessions, but might cause CORS issues if not handled correctly by WC
    };

    if (body) {
        fetchOptions.body = JSON.stringify(body);
        console.log('Server: Request body:', fetchOptions.body);
    }

    try {
        const wooResponse = await fetch(url, fetchOptions);
        console.log(`Server: WooCommerce API response status for ${endpoint}: ${wooResponse.status}`);

        // Extract WooCommerce session token from response headers
        const newWooSessionToken = wooResponse.headers.get('woocommerce-session');
        if (newWooSessionToken) {
            res.setHeader('Cart-Token', newWooSessionToken);
            console.log('Server: Received and setting new Cart-Token header:', newWooSessionToken);
        }

        const responseBody = await wooResponse.json();
        console.log('Server: Received WooCommerce response body:', responseBody);

        // If the response body contains a nonce, include it in our proxy response
        if (responseBody.nonce) {
            console.log('Server: Received nonce in response body:', responseBody.nonce);
            res.setHeader('Nonce', responseBody.nonce); 
        }

        res.status(wooResponse.status).json(responseBody);

    } catch (error) {
        console.error(`Server ERROR: Failed to forward request to WooCommerce ${endpoint}:`, error);
        console.error('Server ERROR details:', error.message, error.stack);
        res.status(500).json({ message: 'Failed to connect to WooCommerce API', error: error.message });
    }
}

// Endpoint to initialize cart session and get products
app.get('/api/init', async (req, res) => {
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
                // Do NOT send WOO_STORE_API_NONCE from env here. Frontend needs to get it from WC response.
                'x-wc-store-api-nonce': req.headers['nonce'] || undefined // Only forward if client sends one
            }
        });

        console.log(`Server: /api/init - WooCommerce /cart response status: ${cartResponse.status}`);

        const newWooSessionToken = cartResponse.headers.get('woocommerce-session');
        if (newWooSessionToken) {
            res.setHeader('Cart-Token', newWooSessionToken);
            console.log('Server: /api/init - Set Cart-Token header from /cart response:', newWooSessionToken);
        }

        const cartData = await cartResponse.json();
        console.log('Server: /api/init - Received cart data from WC:', cartData);

        // Construct the response for the client
        res.status(cartResponse.status).json({
            cart: cartData,
            cartToken: newWooSessionToken || req.headers['cart-token'] || cartData.cartToken, // Provide the new token or existing one
            nonce: cartData.nonce || undefined // Provide nonce from cart data if available
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
    await forwardToWooocommerce(req, res, '/cart');
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
