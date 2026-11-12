const mongoose = require('mongoose');
const dns = require('dns');

// Prevent queryTxt ETIMEOUT issues on MongoDB+srv connections by using reliable DNS servers
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (e) {
  // Ignore if custom DNS cannot be set
}

const connectDB = async () => {
  const uri =
    process.env.MONGODB_URL ||
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.DATABASE_URL;

  if (!uri) {
    console.error('MongoDB connection error: No connection URI found in environment variables (MONGODB_URL or MONGODB_URI)');
    process.exit(1);
  }

  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 8000 // 8s timeout
    });
    console.log(`✅ MongoDB Connected: ${conn.connection.host}/${conn.connection.name}`);
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    if (error.message.includes('ECONNREFUSED 127.0.0.1:27017')) {
      console.error('👉 Hint: Local MongoDB is not running on port 27017. Please set your MongoDB Atlas connection string in .env (MONGODB_URL or MONGODB_URI).');
    }
    process.exit(1);
  }
};

module.exports = connectDB;
