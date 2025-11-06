// backend-service/src/index.ts
import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB connection string
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/userdb';

// User Schema
const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  passwordHash: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Create indexes for better performance
userSchema.index({ username: 1 });
userSchema.index({ email: 1 });

const User = mongoose.model('User', userSchema);

// Failure simulation flags (for chaos engineering)
let SIMULATE_DELAY = false;
let SIMULATE_ERROR = false;
let DELAY_MS = 5000;
let ERROR_RATE = 1; // 100% error rate

// Initialize database connection
async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  res.json({ 
    status: 'healthy',
    database: dbStatus,
    timestamp: new Date().toISOString(),
    simulationMode: {
      delay: SIMULATE_DELAY,
      error: SIMULATE_ERROR
    }
  });
});

app.post('/chaos/delay', (req: Request, res: Response) => {
  const { enabled, delayMs } = req.body;
  console.log(`Backend: Delay simulation updated. Enabled: ${enabled}, Delay MS: ${delayMs}`); // Added log
  SIMULATE_DELAY = enabled;
  if (delayMs) DELAY_MS = delayMs;
  res.json({ message: 'Delay simulation updated', enabled: SIMULATE_DELAY, delayMs: DELAY_MS });
});

app.post('/chaos/error', (req: Request, res: Response) => {
  const { enabled, errorRate } = req.body;
  SIMULATE_ERROR = enabled;
  if (errorRate) ERROR_RATE = errorRate;
  console.log(`Backend: Error simulation updated. Enabled: ${SIMULATE_ERROR}, Error Rate: ${ERROR_RATE}`); // Added log
  res.json({ message: 'Error simulation updated', enabled: SIMULATE_ERROR, errorRate: ERROR_RATE });
});

const chaosMiddleware = async (req: Request, res: Response, next: Function) => {
  console.log(`Backend: Entering chaosMiddleware. SIMULATE_DELAY: ${SIMULATE_DELAY}, SIMULATE_ERROR: ${SIMULATE_ERROR}`); // Added log
  if (SIMULATE_DELAY) {
    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
  }
  
  if (SIMULATE_ERROR && Math.random() < ERROR_RATE) {
    console.log('Backend: Simulating error!'); 
    return res.status(500).json({ error: 'Simulated backend failure' });
  }
  
  next();
};

app.post('/api/register', chaosMiddleware, async (req: Request, res: Response) => {
  const { username, email, password } = req.body;
  console.log(`Backend: Entering chaosMiddleware. SIMULATE_DELAY: ${SIMULATE_DELAY}, SIMULATE_ERROR: ${SIMULATE_ERROR}`); // Added log
  if (SIMULATE_ERROR && Math.random() < ERROR_RATE) {
    console.log('Backend: Simulating error!'); 
    return res.status(500).json({ error: 'Simulated backend failure' });
  }

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const existingUser = await User.findOne({ 
      $or: [{ username }, { email }] 
    });

    if (existingUser) {
      return res.status(409).json({ 
        error: existingUser.username === username 
          ? 'Username already exists' 
          : 'Email already exists' 
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = new User({
      username,
      email,
      passwordHash
    });

    await user.save();

    res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        createdAt: user.createdAt
      }
    });
  } catch (error: any) {
    console.error('Registration error:', error);
    
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/users', chaosMiddleware, async (req: Request, res: Response) => {
  try {
    const users = await User.find()
      .select('-passwordHash')
      .sort({ createdAt: -1 })
      .limit(100);

    res.json({ 
      users: users.map(user => ({
        id: user._id,
        username: user.username,
        email: user.email,
        createdAt: user.createdAt
      })),
      count: users.length
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/users/:id', async (req: Request, res: Response) => {
  try {
    const user = await User.findById(req.params.id).select('-passwordHash');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        createdAt: user.createdAt
      }
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/users/:id', async (req: Request, res: Response) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, async () => {
  console.log(`Backend service running on port ${PORT}`);
  await connectDB();
});