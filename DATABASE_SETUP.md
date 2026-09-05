# Database Setup Guide

## Error: "User.findOne() buffering timed out after 10000ms"

This error occurs when the MongoDB database is not accessible. Follow these steps to fix it:

### Option 1: Use Local MongoDB (Recommended for Development)

1. **Install MongoDB Community Edition**
    - Download from: https://www.mongodb.com/try/download/community
    - Follow the installation guide for your OS

2. **Start MongoDB Server**

    ```bash
    # Windows (if installed with default path)
    mongod

    # Or if using MongoDB as a service, it should start automatically
    ```

3. **Verify MongoDB is Running**

    ```bash
    # In another terminal
    mongo
    # You should see the MongoDB shell
    ```

4. **Start Your Server**
    ```bash
    cd server
    npm install
    node server.js
    ```

---

### Option 2: Use MongoDB Atlas (Cloud Database)

1. **Create MongoDB Atlas Account**
    - Go to: https://www.mongodb.com/cloud/atlas
    - Sign up for free account

2. **Create a Cluster**
    - Click "Create" → Choose Free Tier
    - Wait for cluster to deploy (5-10 minutes)

3. **Get Connection String**
    - Click "Connect"
    - Choose "Connect your application"
    - Copy the connection string

4. **Create .env File**

    ```bash
    cd server
    cp .env.example .env
    ```

5. **Edit .env File**

    ```
    MONGODB_URI=mongodb+srv://username:password@cluster.xxxxx.mongodb.net/crm_db?retryWrites=true&w=majority
    JWT_SECRET=your-secret-key
    API_PORT=3000
    ```

6. **Important: Allow Network Access**
    - In MongoDB Atlas, go to Security → Network Access
    - Click "Add IP Address"
    - Choose "Allow Access from Anywhere" (0.0.0.0/0) for development
    - Click "Confirm"

7. **Update Credentials**
    - Replace `username` and `password` with your MongoDB Atlas user credentials
    - Make sure to URL encode special characters in password (use @ → %40, etc.)

---

### Option 3: Update Environment Variable

If you have MongoDB Atlas set up, you can set the environment variable before starting:

**Windows (PowerShell)**

```powershell
$env:MONGODB_URI="mongodb+srv://username:password@cluster.xxxxx.mongodb.net/crm_db?retryWrites=true&w=majority"
node server.js
```

**Windows (Command Prompt)**

```cmd
set MONGODB_URI=mongodb+srv://username:password@cluster.xxxxx.mongodb.net/crm_db?retryWrites=true&w=majority
node server.js
```

**Linux/Mac**

```bash
export MONGODB_URI="mongodb+srv://username:password@cluster.xxxxx.mongodb.net/crm_db?retryWrites=true&w=majority"
node server.js
```

---

## Troubleshooting

### "connect ECONNREFUSED 127.0.0.1:27017"

- MongoDB is not running locally
- Start MongoDB with `mongod` command

### "MongoAuthenticationError"

- Wrong username/password for MongoDB Atlas
- Check your credentials in .env file
- Make sure to URL encode special characters

### "Network error: connect ETIMEDOUT"

- MongoDB Atlas IP whitelist is not configured
- Go to Security → Network Access in MongoDB Atlas
- Add your IP address or allow all (0.0.0.0/0)

### Still timing out after 10 seconds?

- Check MongoDB Atlas cluster status
- Verify internet connection
- Try Option 1 (Local MongoDB) first for testing

---

## Testing Database Connection

Once configured, the server should show one of these messages:

```
✅ MongoDB Connected: cluster0.xxxxx.mongodb.net
```

or

```
✅ Local MongoDB Connected: localhost
```

Then you can create accounts without timeout errors! 🎉
