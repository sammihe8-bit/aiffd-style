import axios from 'axios'

const API_BASE_URL = 'https://eloquent-enthusiasm-production.up.railway.app/api'

export const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
})

// 请求拦截器 - 添加token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('aiffd_token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// 响应拦截器 - 处理错误
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('aiffd_token')
      localStorage.removeItem('aiffd_user')
      window.location.href = '/auth'
    }
    return Promise.reject(error)
  }
)

// 认证相关API — 后端字段确认：email + password（无 phone）
export const authAPI = {
  register: (data: { name?: string; email: string; password: string }) =>
    api.post('/auth/register', data),
  
  login: (data: { email: string; password: string }) =>
    api.post('/auth/login', data),
  
  getMe: () =>
    api.get('/user/me'),
}

export default api
